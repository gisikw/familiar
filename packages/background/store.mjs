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
  thinkingLevel,
} from "./protocol.mjs";

export const TERMINAL = new Set([
  "rejoined",
  "cancelled",
  "failed",
  "orphaned",
]);
const FENCED = new Set([...TERMINAL, "cancelling", "rejoining"]);
const RECORD_STATUSES = new Set([
  ...TERMINAL,
  "preparing",
  "running",
  "cancelling",
  "rejoining",
]);
const ARCHIVE_OPTIONAL_STATUSES = new Set(["preparing", "orphaned"]);
const MAX_PERSISTED_RECORD_BYTES = LIMITS.admissionBytes + 8 * 1024 * 1024;

class QuarantinedRecordError extends Error {
  constructor(reason) {
    super(`quarantined workstream record (${reason})`);
    this.name = "QuarantinedRecordError";
    this.code = "ERR_BACKGROUND_RECORD_QUARANTINED";
    this.reason = reason;
  }
}

/** Scheduling truth is a single transactional database, not secondary JSON
 * indexes. FULL synchronous WAL commits precede every external side effect.
 * No transaction callback may yield. JSONL delivery remains a separate owner
 * transaction and MUST be reconciled by packet identity after restart. */
export class WorkstreamStore {
  constructor(root, { boundary = () => {}, maxRecords = LIMITS.records } = {}) {
    if (
      !Number.isSafeInteger(maxRecords) ||
      maxRecords <= 0 ||
      maxRecords > LIMITS.records
    )
      throw new Error("invalid workstream record limit");
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
    this.quarantinedRecords = new Map();
    try {
      for (const record of this.list()) this.indexChildren(record);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  validationFailure(record, row) {
    if (!record || typeof record !== "object" || Array.isArray(record))
      return "invalid-record";
    if (record.version !== 3) return "unsupported-version";
    try {
      id(record.id);
      id(record.admission?.admissionId);
      id(record.admission?.parentSessionId);
      if (record.admission?.parentLeafId !== null)
        id(record.admission?.parentLeafId);
      id(record.admission?.projectId);
    } catch {
      return "invalid-record-identity";
    }
    if (
      typeof record.admission.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.admission.digest) ||
      (row &&
        (record.id !== row.id ||
          record.admission.admissionId !== row.admission_id ||
          record.admission.digest !== row.digest ||
          record.revision !== row.revision))
    )
      return "identity-mismatch";
    if (
      !Number.isSafeInteger(record.revision) ||
      record.revision < 0 ||
      !Number.isSafeInteger(record.generation) ||
      record.generation <= 0 ||
      !RECORD_STATUSES.has(record.status) ||
      !Number.isFinite(record.createdAt) ||
      !Number.isFinite(record.updatedAt) ||
      !Number.isSafeInteger(record.run) ||
      record.run < 0 ||
      (record.settledRun !== null &&
        (!Number.isSafeInteger(record.settledRun) || record.settledRun < 0)) ||
      !Array.isArray(record.commands) ||
      !Array.isArray(record.children) ||
      !Array.isArray(record.packets) ||
      record.commands.length > LIMITS.commands ||
      record.children.length > LIMITS.children ||
      record.packets.length > LIMITS.packets ||
      record.commands.some((entry) => !entry || typeof entry !== "object") ||
      record.children.some((entry) => !entry || typeof entry !== "object") ||
      record.packets.some((entry) => !entry || typeof entry !== "object")
    )
      return "invalid-record-shape";
    try {
      bounded(record.admission, LIMITS.admissionBytes, "persisted admission");
      for (const command of record.commands)
        bounded(command, LIMITS.commandBytes, "persisted command");
      for (const child of record.children)
        bounded(child, LIMITS.commandBytes * 4, "persisted child");
      for (const packet of record.packets) {
        id(packet.packetId);
        if (!Number.isSafeInteger(packet.run) || packet.run < 0)
          throw new Error("invalid packet run");
        report(reportData(packet));
      }
    } catch {
      return "invalid-record-shape";
    }
    const hasArchive = record.archive !== undefined;
    if (hasArchive) {
      if (
        !record.archive ||
        typeof record.archive !== "object" ||
        typeof record.archive.file !== "string" ||
        !record.archive.file.startsWith("/") ||
        typeof record.archive.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.archive.sha256)
      )
        return "invalid-archive";
      try {
        id(record.archive.sessionId);
      } catch {
        return "invalid-archive";
      }
      if (
        !record.model ||
        typeof record.model.provider !== "string" ||
        !record.model.provider ||
        typeof record.model.id !== "string" ||
        !record.model.id
      )
        return "invalid-model";
      try {
        bounded(record.model, 1024, "persisted branch model");
      } catch {
        return "invalid-model";
      }
      try {
        thinkingLevel(record.thinkingLevel);
      } catch {
        return "invalid-thinking-level";
      }
    } else if (
      record.model !== undefined ||
      record.thinkingLevel !== undefined
    ) {
      return "incomplete-branch-configuration";
    } else if (!ARCHIVE_OPTIONAL_STATUSES.has(record.status)) {
      return "missing-archive";
    }
    return null;
  }
  rowDiagnostic(row, reason) {
    return Object.freeze({
      recordId:
        typeof row.id === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.id)
          ? row.id
          : null,
      reason,
      revision: Number.isSafeInteger(row.revision) ? row.revision : null,
      bodyBytes: Number.isSafeInteger(row.body_bytes)
        ? Math.min(row.body_bytes, MAX_PERSISTED_RECORD_BYTES + 1)
        : null,
    });
  }
  decodeRow(row, failClosed = false) {
    let record;
    let reason;
    if (
      !Number.isSafeInteger(row.body_bytes) ||
      row.body_bytes > MAX_PERSISTED_RECORD_BYTES ||
      typeof row.body !== "string"
    ) {
      reason = "oversized-record";
    } else {
      try {
        record = JSON.parse(row.body);
      } catch {
        reason = "malformed-json";
      }
      if (!reason) reason = this.validationFailure(record, row);
    }
    if (reason) {
      this.quarantinedRecords.set(
        row.storage_rowid,
        this.rowDiagnostic(row, reason),
      );
      this.publicRecords.delete(row.id);
      for (const [jobId, owner] of this.childOwners)
        if (owner.id === row.id) this.childOwners.delete(jobId);
      if (failClosed) throw new QuarantinedRecordError(reason);
      return undefined;
    }
    this.quarantinedRecords.delete(row.storage_rowid);
    return record;
  }
  selectRows(where = "", value) {
    const sql = `SELECT rowid AS storage_rowid, id, admission_id, digest,
      revision, length(CAST(body AS BLOB)) AS body_bytes,
      CASE WHEN length(CAST(body AS BLOB)) <= ? THEN body END AS body
      FROM workstreams ${where}`;
    const statement = this.db.prepare(sql);
    return value === undefined
      ? statement.all(MAX_PERSISTED_RECORD_BYTES, this.maxRecords)
      : statement.all(MAX_PERSISTED_RECORD_BYTES, value);
  }
  quarantineList() {
    return Object.freeze([...this.quarantinedRecords.values()]);
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
    const rows = this.selectRows("WHERE id=?", id(key));
    return rows.length ? this.decodeRow(rows[0], true) : undefined;
  }
  byAdmission(key) {
    const rows = this.selectRows("WHERE admission_id=?", id(key));
    return rows.length ? this.decodeRow(rows[0], true) : undefined;
  }
  list() {
    const rows = this.selectRows("ORDER BY rowid LIMIT ?");
    const seen = new Set(rows.map((row) => row.storage_rowid));
    for (const key of this.quarantinedRecords.keys())
      if (!seen.has(key)) this.quarantinedRecords.delete(key);
    return rows.map((row) => this.decodeRow(row)).filter(Boolean);
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
        version: 3,
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
      const body = bounded(record, MAX_PERSISTED_RECORD_BYTES, "record");
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
  prepare(
    key,
    generation,
    archive,
    canonicalFile,
    model,
    capturedThinkingLevel,
  ) {
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
      if (
        !model ||
        typeof model.provider !== "string" ||
        typeof model.id !== "string"
      )
        throw new Error("invalid branch model");
      r.model = { provider: model.provider, id: model.id };
      r.thinkingLevel = thinkingLevel(capturedThinkingLevel);
      bounded(r.model, 1024, "branch model");
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
  recover(hasCanonicalPacket, hasCanonicalAdmission = () => false) {
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
        } else if (r.status === "preparing") {
          // Admission was in flight at the crash (its ledger receipt may not
          // have been written). Decide by explicit canonical proof, never by
          // write ordering: a committed dispatch entry means the delegation
          // landed; its absence means it did not. Either way the workstream is
          // orphaned for inspection and never replayed under a fresh identity.
          r.status = "orphaned";
          r.failure = hasCanonicalAdmission(r)
            ? "Admission committed to the canonical parent before restart; execution requires review"
            : "Admission outcome uncertain after restart; requires review and is never replayed";
        } else {
          // Never resume an uncertain model/tool/child side effect. Even a
          // previously settled report may have acquired work before the crash.
          // A committed admission with a missing dispatch entry is a harmful
          // partial state surfaced explicitly, not silently retried.
          r.status = "orphaned";
          r.failure = hasCanonicalAdmission(r)
            ? "Host restarted; execution/delivery outcome requires review"
            : "Host restarted; canonical admission proof missing, requires inspection";
        }
        r.generation++;
        r.settledRun = null;
      });
    }
  }
}
