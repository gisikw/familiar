import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  admission,
  bounded,
  id,
  LIMITS,
  report,
  reportData,
} from "./protocol.mjs";

export const TERMINAL = new Set([
  "rejoined",
  "cancelled",
  "failed",
  "orphaned",
]);
const FENCED = new Set([...TERMINAL, "cancelling", "rejoining"]);

/** Scheduling truth is a single transactional database, not secondary JSON
 * indexes. FULL synchronous WAL commits precede every external side effect.
 * No transaction callback may yield. JSONL delivery remains a separate owner
 * transaction and MUST be reconciled by packet identity after restart. */
export class WorkstreamStore {
  constructor(root, { boundary = () => {}, maxRecords = LIMITS.records } = {}) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
      throw new Error("unsafe workstream root");
    const file = join(root, "workstreams.sqlite");
    try {
      const existing = lstatSync(file);
      if (
        !existing.isFile() ||
        existing.isSymbolicLink() ||
        existing.mode & 0o077
      )
        throw new Error("unsafe workstream database");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=1000; PRAGMA max_page_count=65536;
      CREATE TABLE IF NOT EXISTS workstreams (
        id TEXT PRIMARY KEY, admission_id TEXT NOT NULL UNIQUE,
        digest TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL
      );`);
    this.boundary = boundary;
    this.maxRecords = maxRecords;
    this.childOwners = new Map();
    this.publicRecords = new Map();
    for (const record of this.list()) this.indexChildren(record);
  }
  indexChildren(record) {
    const packet = record.packets?.at(-1);
    const reportFields = Object.fromEntries(
      [
        "decisions",
        "durableContext",
        "risks",
        "questions",
        "changedArtifacts",
      ].map((key) => [
        key,
        Array.isArray(packet?.[key])
          ? packet[key]
              .filter((text) => typeof text === "string")
              .map((text) => text.slice(0, 2048))
          : [],
      ]),
    );
    // Derived, immutable public cache: UI token-rate projection must never
    // decode admission images or copy child requests/archives out of SQLite.
    const view = {
      id: record.id,
      generation: record.generation,
      status: record.status,
      projectId: record.admission.projectId,
      sessionId: record.admission.parentSessionId,
      settled:
        record.settledRun === record.run &&
        !record.childWake &&
        !record.commands.some((command) => command.status !== "done"),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      resourceQuarantined: Boolean(record.resourceQuarantined),
      archiveExpired: Boolean(record.archive?.expired),
      failure:
        typeof (record.failure ?? record.cancelReason) === "string"
          ? (record.failure ?? record.cancelReason).slice(0, 1024)
          : undefined,
      packets: packet
        ? [
            {
              packetId: packet.packetId,
              disposition: packet.disposition,
              ...reportFields,
              integrationRef:
                typeof packet.integrationRef === "string"
                  ? packet.integrationRef.slice(0, 2048)
                  : null,
              summary:
                typeof packet.summary === "string"
                  ? packet.summary.slice(0, 8192)
                  : "",
            },
          ]
        : [],
      children: (record.children ?? []).map((child) => ({
        jobId: child.jobId,
        referenceId:
          child.jobId ??
          `intent-${createHash("sha256")
            .update(String(child.createKey ?? child.key ?? ""))
            .digest("hex")
            .slice(0, 24)}`,
        createRef: child.createKey,
        terminal: child.terminal,
        questionId: child.questionId,
        reviewPending: Boolean(child.pendingEvent),
        pendingEvent:
          child.questionId && child.pendingEvent
            ? {
                job: {
                  question: {
                    prompt: String(
                      child.pendingEvent?.job?.question?.prompt ?? "",
                    ).slice(0, 2048),
                  },
                },
              }
            : null,
      })),
    };
    const freeze = (value) => {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
      return value;
    };
    this.publicRecords.set(record.id, freeze(view));
    for (const [jobId, owner] of this.childOwners)
      if (owner.id === record.id) this.childOwners.delete(jobId);
    for (const child of record.children ?? [])
      if (child.jobId)
        this.childOwners.set(child.jobId, {
          id: record.id,
          generation: record.generation,
          status: record.status,
        });
  }
  publicList(sessionId) {
    const priority = (record) =>
      ["preparing", "running", "cancelling", "rejoining"].includes(
        record.status,
      )
        ? 0
        : record.status === "orphaned" || record.resourceQuarantined
          ? 1
          : 2;
    return [...this.publicRecords.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort(
        (a, b) =>
          priority(a) - priority(b) ||
          (priority(a) === 2
            ? b.createdAt - a.createdAt
            : a.createdAt - b.createdAt),
      );
  }
  childOwner(jobId) {
    return this.childOwners.get(jobId);
  }
  close() {
    this.db.close();
  }
  get(key) {
    const row = this.db
      .prepare("SELECT body FROM workstreams WHERE id=?")
      .get(id(key));
    return row ? JSON.parse(row.body) : undefined;
  }
  byAdmission(key) {
    const row = this.db
      .prepare("SELECT body FROM workstreams WHERE admission_id=?")
      .get(id(key));
    return row ? JSON.parse(row.body) : undefined;
  }
  list() {
    return this.db
      .prepare("SELECT body FROM workstreams ORDER BY rowid LIMIT ?")
      .all(this.maxRecords)
      .map((r) => JSON.parse(r.body));
  }
  transaction(label, fn) {
    // Never accumulate an unbounded WAL behind a reader holding an old snapshot.
    // Each accepted mutation starts from an empty journal and writes one bounded
    // record. External inspectors must release their read transaction first.
    const checkpoint = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint.busy !== 0)
      throw new Error("workstream journal checkpoint busy");
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const result = fn();
      if (result && typeof result.then === "function")
        throw new Error("transaction must not yield");
      this.boundary(`${label}:before-commit`);
      this.db.exec("COMMIT");
      committed = true;
      const record = result?.record ?? result;
      if (record?.children) this.indexChildren(record);
      this.boundary(`${label}:after-commit`);
      return result;
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  create(request) {
    const admitted = admission(request);
    return this.transaction("admit", () => {
      const existing = this.byAdmission(admitted.admissionId);
      if (existing) {
        if (existing.admission.digest !== admitted.digest)
          throw new Error("admission replay conflict");
        return { record: existing, created: false };
      }
      const count = this.db
        .prepare("SELECT count(*) AS n FROM workstreams")
        .get().n;
      if (count >= this.maxRecords)
        throw new Error("archive record quota reached");
      if (
        this.list().filter((r) => !TERMINAL.has(r.status)).length >=
        LIMITS.active
      )
        throw new Error("active workstream quota reached");
      const record = {
        version: 2,
        id: randomUUID(),
        revision: 0,
        generation: 1,
        admission: admitted,
        status: "preparing",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        run: 0,
        settledRun: null,
        commands: [],
        children: [],
        packets: [],
        deliveredPacketId: null,
      };
      this.db
        .prepare("INSERT INTO workstreams VALUES (?,?,?,?,?)")
        .run(
          record.id,
          admitted.admissionId,
          admitted.digest,
          0,
          JSON.stringify(record),
        );
      this.boundary("admit:written");
      return { record, created: true };
    });
  }
  update(key, generation, label, fn) {
    return this.transaction(label, () => {
      const record = this.get(key);
      if (!record || record.generation !== generation)
        throw new Error("stale workstream generation");
      const revision = record.revision;
      fn(record);
      record.revision++;
      record.updatedAt = Date.now();
      const body = bounded(
        record,
        LIMITS.admissionBytes + 8 * 1024 * 1024,
        "record",
      );
      const result = this.db
        .prepare(
          "UPDATE workstreams SET revision=?, body=? WHERE id=? AND revision=?",
        )
        .run(record.revision, body, key, revision);
      if (result.changes !== 1) throw new Error("stale revision");
      this.boundary(`${label}:written`);
      return record;
    });
  }
  prepare(key, generation, archive, canonicalFile, model) {
    return this.update(key, generation, "prepare", (r) => {
      if (r.status !== "preparing") throw new Error("not preparing");
      if (
        !archive ||
        typeof archive.file !== "string" ||
        !archive.file.startsWith("/") ||
        typeof archive.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(archive.sha256)
      )
        throw new Error("invalid archive");
      bounded(archive, 4096, "archive");
      id(archive.sessionId);
      r.archive = archive;
      if (model !== undefined) {
        if (typeof model.provider !== "string" || typeof model.id !== "string")
          throw new Error("invalid branch model");
        r.model = { provider: model.provider, id: model.id };
        bounded(r.model, 1024, "branch model");
      }
      if (canonicalFile !== undefined) {
        if (typeof canonicalFile !== "string" || !canonicalFile.startsWith("/"))
          throw new Error("invalid canonical archive reference");
        bounded(canonicalFile, 4096, "canonical archive reference");
        r.canonicalFile = canonicalFile;
      }
    });
  }
  admitReceipt(key, generation, receipt) {
    return this.update(key, generation, "admit-receipt", (r) => {
      if (r.status !== "preparing" || !r.archive)
        throw new Error("not prepared");
      r.foregroundUserEntryId = id(receipt.userEntryId);
      r.foregroundControlEntryId = id(receipt.controlEntryId);
      r.status = "running";
    });
  }
  start(key, generation) {
    return this.update(key, generation, "start", (r) => {
      if (FENCED.has(r.status) || r.status === "preparing")
        throw new Error("cannot start");
      r.run++;
      r.settledRun = null;
      r.status = "running";
    });
  }
  settle(key, generation, run) {
    return this.update(key, generation, "settle", (r) => {
      if (FENCED.has(r.status) || r.run !== run)
        throw new Error("stale settlement");
      r.settledRun = run;
    });
  }
  enqueue(key, generation, commandId, content) {
    id(commandId);
    bounded(content, LIMITS.commandBytes, "steering");
    if (typeof content !== "string" || !content.trim())
      throw new Error("empty steering");
    return this.update(key, generation, "steer", (r) => {
      if (FENCED.has(r.status) || r.status === "preparing")
        throw new Error("cannot steer");
      const replay = r.commands.find((c) => c.id === commandId);
      if (replay) {
        if (replay.content !== content)
          throw new Error("steering replay conflict");
        return;
      }
      if (r.commands.length >= LIMITS.commands)
        throw new Error("steering quota reached");
      r.commands.push({ id: commandId, content, status: "queued" });
      r.settledRun = null;
    });
  }
  saveReport(key, generation, value) {
    const normalized = report(value);
    let saved;
    this.update(key, generation, "report", (r) => {
      if (FENCED.has(r.status) || r.status === "preparing")
        throw new Error("cannot report");
      const replay = r.packets.find((p) => p.reportId === normalized.reportId);
      if (replay) {
        if (
          JSON.stringify(report(reportData(replay))) !==
          JSON.stringify(normalized)
        )
          throw new Error("report replay conflict");
        saved = replay;
        return;
      }
      if (r.packets.length >= LIMITS.packets)
        throw new Error("report quota reached");
      saved = { ...normalized, packetId: randomUUID(), run: r.run };
      r.packets.push(saved);
    });
    return saved;
  }
  assertRejoin(r, packetId) {
    if (FENCED.has(r.status) || r.status === "preparing")
      throw new Error("cannot rejoin or replay");
    const packet = r.packets.at(-1);
    if (
      !packet ||
      packet.packetId !== packetId ||
      packet.run !== r.run ||
      !["ready", "failed", "refused", "narrowed", "returned"].includes(
        packet.disposition,
      )
    )
      throw new Error("invalid or superseded merge packet");
    // Refusal/narrowing can return early, but cannot abandon children, pending
    // tools, or a live writer. Broker requests may be made during the reporting
    // tool; actual delivery always waits for the current settlement fence.
    if (
      r.settledRun !== r.run ||
      r.childWake ||
      r.commands.some((c) => c.status !== "done") ||
      r.children.some((c) => !c.terminal || c.questionId || c.pendingEvent) ||
      (packet.disposition === "ready" && packet.questions.length)
    )
      throw new Error("branch not settled");
    if (!r.archive) throw new Error("archive missing");
  }
  beginRejoin(key, generation, packetId) {
    return this.update(key, generation, "rejoin", (r) => {
      this.assertRejoin(r, packetId);
      r.status = "rejoining";
      r.selectedPacketId = packetId;
    });
  }
  delivered(key, generation, packetId) {
    return this.update(key, generation, "delivered", (r) => {
      if (
        r.status !== "rejoining" ||
        r.selectedPacketId !== packetId ||
        r.deliveredPacketId
      )
        throw new Error("invalid delivery receipt");
      r.deliveredPacketId = packetId;
      r.status = "rejoined";
      if (!r.resourceQuarantined) delete r.failure;
    });
  }
  cancel(key, generation, reason) {
    return this.update(key, generation, "cancel", (r) => {
      if (
        TERMINAL.has(r.status) ||
        r.status === "rejoining" ||
        r.status === "cancelling"
      )
        throw new Error("cannot cancel");
      r.status = "cancelling";
      if (reason !== undefined) {
        bounded(reason, 1024, "cancellation reason");
        r.cancelReason = reason;
      }
      r.generation++;
      r.settledRun = null;
    });
  }
  recover(hasCanonicalPacket) {
    // Recovery is called only after a host has acquired exclusive ownership of
    // the runtime, never while another host can still execute these records.
    for (const record of this.list()) {
      if (TERMINAL.has(record.status)) continue;
      this.update(record.id, record.generation, "recover", (r) => {
        if (
          r.status === "rejoining" &&
          hasCanonicalPacket(r, r.selectedPacketId)
        ) {
          r.deliveredPacketId = r.selectedPacketId;
          r.status = "rejoined";
        } else {
          // Never resume an uncertain model/tool/child side effect. Even a
          // previously settled report may have acquired work before the crash.
          r.status = "orphaned";
          r.failure =
            "Host restarted; execution/delivery outcome requires review";
        }
        r.generation++;
        r.settledRun = null;
      });
    }
  }
}
