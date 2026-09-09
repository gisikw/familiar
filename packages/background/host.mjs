import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, openSync, fsyncSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkstreamStore } from "./store.mjs";
import { ResourcePolicy } from "./resources.mjs";
import { BranchScheduler } from "./scheduler.mjs";
import { admission, bounded, LIMITS, mergeContent } from "./protocol.mjs";

function durable(file, content) {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
}

/** One host is bound to one canonical owner birth. All canonical writes go
 * through Pi's lifecycle-fenced API; never open the canonical file as a writer.
 * createRuntime is deferred until after both the canonical transaction and its
 * scheduling receipt. No provider/factory callback runs under admission.
 */
export class BackgroundHost {
  constructor({ root, owner, createRuntime, store, scheduler, onError = () => {}, onChange = () => {} }) {
    this.root = root;
    this.owner = owner;
    this.createRuntime = createRuntime;
    this.onError = onError;
    this.onChange = onChange;
    this.store = store ?? new WorkstreamStore(root);
    this.pendingRejoins = false;
    this.scheduler = scheduler ?? new BranchScheduler(this.store, { onError, onSettled: (key) => {
      if (this.store.get(key)?.packets.at(-1)?.requestedRejoin) this.pendingRejoins = true;
      this.flushRejoins();
    } });
    this.resources = new ResourcePolicy(root);
    this.closed = false;
    this.preparations = new Map();
    this.store.recover((r, packetId) => this.hasPacket(r, packetId));
    this.resources.collect(this.store);
  }
  hasPacket(record, packetId) {
    const snapshot = this.owner.snapshot();
    const packet = record.packets.find((p) => p.packetId === packetId);
    return Boolean(packet) && snapshot.sessionId === record.admission.parentSessionId &&
      snapshot.entries.some((e) => {
        if (e.type !== "custom_message" || e.customType !== "familiar.background.merge" || e.details?.packetId !== packetId) return false;
        try {
          const envelope = JSON.parse(e.content);
          return e.content === mergeContent(record, packet, envelope.canonicalLeafId);
        } catch { return false; }
      });
  }
  admit(request, existingUserEntryId) {
    if (this.closed) throw new Error("host closed");
    const normalized = admission(request);
    const snapshot = this.owner.snapshot();
    if (!snapshot.idle || snapshot.private || snapshot.sessionId !== normalized.parentSessionId || snapshot.leafId !== normalized.parentLeafId)
      throw new Error("canonical admission conflict");
    let messages = snapshot.messages;
    if (existingUserEntryId) {
      const user = [...snapshot.entries].reverse().find((e) => e.type === "message" && e.message.role === "user");
      if (user?.id !== existingUserEntryId || JSON.stringify(user.message.content) !== JSON.stringify(normalized.content))
        throw new Error("current user entry changed");
      const index = messages.findLastIndex((message) => message.role === "user");
      if (index < 0) throw new Error("current user context missing");
      messages = messages.slice(0, index);
    }
    bounded(messages, LIMITS.contextBytes, "context snapshot");
    const prior = this.store.byAdmission(normalized.admissionId);
    if (prior) {
      if (prior.admission.digest !== normalized.digest) throw new Error("admission replay conflict");
      throw new Error("admission already consumed");
    }
    if (this.scheduler.live.size + this.preparations.size >= LIMITS.active) throw new Error("live writer quota reached");
    this.resources.collect(this.store, new Set(this.scheduler.live.keys()));
    this.resources.admit();
    const { record } = this.store.create(normalized);
    try {
      const directory = join(this.root, record.id);
      mkdirSync(directory, { mode: 0o700 });
      const sessionId = randomUUID();
      const file = join(directory, "branch.jsonl");
      const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: snapshot.cwd };
      let parentId = null;
      const entries = [...messages, { role: "user", content: normalized.content, timestamp: Date.now() }].map((message) => {
        const entry = { type: "message", id: randomUUID(), parentId, timestamp: new Date().toISOString(), message };
        parentId = entry.id;
        return entry;
      });
      const body = [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
      durable(file, body);
      for (const path of [directory, this.root]) {
        const fd = openSync(path, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      const archive = { sessionId, file, sha256: createHash("sha256").update(body).digest("hex") };
      this.store.prepare(record.id, record.generation, archive);
      const receipt = { version: 2, provenance: "runtime-control", workstreamId: record.id, admissionId: normalized.admissionId, branchSessionId: sessionId };
      const ids = this.owner.commit(normalized.parentSessionId, normalized.parentLeafId, [
        ...(!existingUserEntryId ? [{ type: "message", message: { role: "user", content: normalized.content, timestamp: Date.now() } }] : []),
        { type: "custom", customType: "familiar.background-dispatch", data: receipt },
      ]);
      this.store.admitReceipt(record.id, record.generation, { userEntryId: existingUserEntryId ?? ids[0], controlEntryId: ids.at(-1) });
      const task = new Promise((resolve) => setImmediate(resolve)).then(async () => {
        if (this.closed) return;
        const runtime = await this.createRuntime(this.store.get(record.id), this);
        if (this.closed) { await runtime.abort(); runtime.dispose(); return; }
        this.scheduler.register(record.id, record.generation, runtime);
        this.scheduler.start(record.id, record.generation);
      }).catch((error) => {
        this.onError(error);
        const current = this.store.get(record.id);
        if (current && current.generation === record.generation)
          this.store.update(record.id, record.generation, "runtime-failed", (r) => { r.status = "orphaned"; r.failure = "Runtime preparation failed; review required"; });
      }).finally(() => this.preparations.delete(record.id));
      this.preparations.set(record.id, task);
      return receipt;
    } catch (error) {
      // A committed canonical receipt is not undone. Recovery can inspect it,
      // but uncertain admissions are never automatically executed on restart.
      this.store.update(record.id, record.generation, "admission-failed", (r) => { r.status = "orphaned"; r.failure = "Admission outcome requires review"; });
      throw error;
    }
  }
  flushRejoins() {
    if (this.closed || !this.pendingRejoins || (this.owner.available && !this.owner.available())) return;
    const snapshot = this.owner.snapshot();
    if (!snapshot.idle || snapshot.private) return;
    this.pendingRejoins = false;
    for (const record of this.store.list()) {
      const packet = record.packets.at(-1);
      if (record.status !== "running" || record.settledRun !== record.run || !packet?.requestedRejoin ||
        ["progress", "blocked"].includes(packet.disposition) || record.commands.some((c) => c.status !== "done") ||
        record.children.some((c) => !c.terminal || c.questionId || c.pendingEvent) ||
        (packet.disposition === "ready" && packet.questions.length)) continue;
      this.rejoin(record.id, record.generation, packet.packetId, this.owner.snapshot().leafId);
    }
  }
  report(key, generation, packet) {
    const saved = this.store.saveReport(key, generation, packet);
    if (saved.requestedRejoin) this.pendingRejoins = true;
    this.onChange();
    return saved;
  }
  rejoin(key, generation, packetId, expectedLeafId) {
    if (this.closed) throw new Error("host closed");
    const record = this.store.get(key);
    const snapshot = this.owner.snapshot();
    if (!record || record.admission.parentSessionId !== snapshot.sessionId) {
      if (record && record.generation === generation)
        this.store.update(key, generation, "parent-orphaned", (r) => { r.status = "orphaned"; r.failure = "Canonical session changed"; });
      throw new Error("parent session changed");
    }
    if (!snapshot.idle || snapshot.private || snapshot.leafId !== expectedLeafId)
      throw new Error("canonical merge conflict");
    if (record.status !== "running" || record.generation !== generation) throw new Error("cannot rejoin or replay");
    const archiveFd = openSync(record.archive.file, "r");
    try { fsyncSync(archiveFd); } finally { closeSync(archiveFd); }
    const bytes = readFileSync(record.archive.file);
    bounded(bytes.toString("utf8"), LIMITS.contextBytes * 2, "archive");
    this.store.update(key, generation, "archive-sealed", (r) => {
      r.archive.sha256 = createHash("sha256").update(bytes).digest("hex");
    });
    const selected = this.store.beginRejoin(key, generation, packetId);
    const packet = selected.packets.find((p) => p.packetId === packetId);
    const content = mergeContent(selected, packet, expectedLeafId);
    this.owner.commit(snapshot.sessionId, expectedLeafId, [{
      type: "custom_message", customType: "familiar.background.merge", content, display: true,
      details: { packetId, workstreamId: key },
    }]);
    this.store.delivered(key, generation, packetId);
    this.onChange();
    const lane = this.scheduler.live.get(key);
    if (lane && !lane.busy) {
      clearTimeout(lane.idleTimer);
      lane.runtime.dispose();
      this.scheduler.live.delete(key);
    }
    return { packetId };
  }
  inspect(key) {
    const r = this.store.get(key);
    if (!r) throw new Error("unknown workstream");
    // Inspection intentionally projects reports/owned children, not a transcript.
    return { id: r.id, generation: r.generation, status: r.status, projectId: r.admission.projectId,
      sessionId: r.admission.parentSessionId, packets: r.packets, children: r.children,
      archiveSessionId: r.archive?.sessionId };
  }
  async shutdown() {
    this.closed = true;
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([...this.preparations.values()]),
        new Promise((resolve) => { timer = setTimeout(resolve, this.scheduler.abortTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
    const preparing = [...this.preparations.keys()];
    for (const key of preparing) {
      const record = this.store.get(key);
      if (record && record.status === "running") this.store.update(key, record.generation, "preparation-quarantined", (r) => {
        r.generation++; r.status = "orphaned"; r.failure = "Runtime construction did not drain; writer quarantined";
      });
    }
    const result = await this.scheduler.shutdown();
    result.quarantined.push(...preparing);
    if (result.quarantined.length === 0) this.store.close();
    return result;
  }
}
