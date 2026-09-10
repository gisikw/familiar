import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  readFileSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { WorkstreamStore } from "./store.mjs";
import { ResourcePolicy } from "./resources.mjs";
import { BranchScheduler } from "./scheduler.mjs";
import {
  admission,
  bounded,
  LIMITS,
  mergeContent,
  thinkingLevel,
} from "./protocol.mjs";

function durable(file, content, boundary) {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, content);
    boundary("archive:written");
    fsyncSync(fd);
    boundary("archive:fsynced");
  } finally {
    closeSync(fd);
  }
}

/** One host is bound to one canonical owner birth. All canonical writes go
 * through Pi's lifecycle-fenced API; never open the canonical file as a writer.
 * createRuntime is deferred until after both the canonical transaction and its
 * scheduling receipt. No provider/factory callback runs under admission.
 */
export class BackgroundHost {
  constructor({
    root,
    owner,
    createRuntime,
    store,
    scheduler,
    onError = () => {},
    onChange = () => {},
    boundary = () => {},
  }) {
    this.root = root;
    this.owner = owner;
    this.createRuntime = createRuntime;
    this.onError = onError;
    this.onChange = onChange;
    this.boundary = boundary;
    this.store = store ?? new WorkstreamStore(root, { boundary });
    this.pendingRejoins = false;
    this.scheduler =
      scheduler ??
      new BranchScheduler(this.store, {
        onError,
        onChange,
        onSettled: (key) => {
          if (this.store.get(key)?.packets.at(-1)?.requestedRejoin)
            this.pendingRejoins = true;
          this.flushRejoins();
        },
      });
    this.resources = new ResourcePolicy(root);
    this.closed = false;
    this.preparations = new Map();
    try {
      // The caller acquired the host lease before construction. A canonical
      // transaction cannot outlive that process, so only its dead birth can
      // have left these recorded, fixed-name temporary files behind.
      for (const record of this.store.list())
        if (record.canonicalFile) {
          const temporary = `${record.canonicalFile}.runtime-control.tmp`;
          try {
            if (!lstatSync(temporary).isFile())
              throw new Error("unsafe canonical temporary");
            unlinkSync(temporary);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
      this.store.recover(
        (r, packetId) => this.hasPacket(r, packetId),
        (r) => this.hasCanonicalAdmission(r),
      );
      this.resources.collect(this.store);
    } catch (error) {
      this.store.close();
      throw error;
    }
  }
  hasPacket(record, packetId) {
    const snapshot = this.owner.snapshot();
    const packet = record.packets.find((p) => p.packetId === packetId);
    return (
      Boolean(packet) &&
      snapshot.sessionId === record.admission.parentSessionId &&
      snapshot.entries.some((e) => {
        if (
          e.type !== "custom_message" ||
          e.customType !== "familiar.background.merge" ||
          e.details?.packetId !== packetId
        )
          return false;
        try {
          const envelope = JSON.parse(e.content);
          return (
            e.content === mergeContent(record, packet, envelope.canonicalLeafId)
          );
        } catch {
          return false;
        }
      })
    );
  }
  /** Explicit admission proof, analogous to hasPacket() for a merge. The exact
   * familiar.background-dispatch control entry is the only durable evidence that
   * an admission was committed to the canonical parent; write atomicity is never
   * assumed. The receipt is reconstructed from stable record identity and, once
   * the ledger recorded it, matched by controlEntryId. Because the batch commits
   * the dispatch entry last, its presence implies the whole batch landed; its
   * absence (including a torn trailing line dropped on reopen) means the
   * admission is not committed and must never be replayed under a fresh id. */
  hasCanonicalAdmission(record) {
    if (!record?.archive) return false;
    const snapshot = this.owner.snapshot();
    if (snapshot.sessionId !== record.admission.parentSessionId) return false;
    const receipt = {
      version: 2,
      provenance: "runtime-control",
      workstreamId: record.id,
      admissionId: record.admission.admissionId,
      branchSessionId: record.archive.sessionId,
    };
    const expected = JSON.stringify(receipt);
    return snapshot.entries.some((e) => {
      if (e.type !== "custom" || e.customType !== "familiar.background-dispatch")
        return false;
      if (
        record.foregroundControlEntryId &&
        e.id !== record.foregroundControlEntryId
      )
        return false;
      try {
        return JSON.stringify(e.data) === expected;
      } catch {
        return false;
      }
    });
  }
  admit(request, existingUserEntryId) {
    if (this.closed) throw new Error("host closed");
    const normalized = admission(request);
    const snapshot = this.owner.snapshot({ context: true });
    if (
      !snapshot.idle ||
      snapshot.private ||
      snapshot.sessionId !== normalized.parentSessionId ||
      snapshot.leafId !== normalized.parentLeafId
    )
      throw new Error("canonical admission conflict");
    if (!snapshot.model) throw new Error("branch model unavailable");
    thinkingLevel(snapshot.thinkingLevel);
    let messages = snapshot.messages;
    let userTimestamp = Date.now();
    if (existingUserEntryId) {
      const user = [...snapshot.entries]
        .reverse()
        .find((e) => e.type === "message" && e.message.role === "user");
      if (
        user?.id !== existingUserEntryId ||
        JSON.stringify(user.message.content) !==
          JSON.stringify(normalized.content)
      )
        throw new Error("current user entry changed");
      const index = messages.findLastIndex(
        (message) => message.role === "user",
      );
      if (index < 0) throw new Error("current user context missing");
      messages = messages.slice(0, index);
      userTimestamp = user.message.timestamp ?? userTimestamp;
    }
    const userMessage = {
      role: "user",
      content: normalized.content,
      timestamp: userTimestamp,
    };
    // Bound the exact effective child context that will be written to the branch
    // archive - the derived context messages plus the admitted user message -
    // never the owner's raw canonical branch. Refusal happens here, before
    // store.create: an oversized effective context creates nothing.
    const childContext = [...messages, userMessage];
    bounded(childContext, LIMITS.contextBytes, "context snapshot");
    const prior = this.store.byAdmission(normalized.admissionId);
    if (prior) {
      if (prior.admission.digest !== normalized.digest)
        throw new Error("admission replay conflict");
      throw new Error("admission already consumed");
    }
    if (this.scheduler.live.size + this.preparations.size >= LIMITS.active)
      throw new Error("live writer quota reached");
    this.resources.collect(this.store, new Set(this.scheduler.live.keys()));
    this.resources.admit(
      this.store,
      new Set([...this.scheduler.live.keys(), ...this.preparations.keys()]),
    );
    const { record } = this.store.create(normalized);
    try {
      const directory = join(this.root, record.id);
      mkdirSync(directory, { mode: 0o700 });
      const sessionId = randomUUID();
      const file = join(directory, "branch.jsonl");
      const header = {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: snapshot.cwd,
      };
      let parentId = null;
      const entries = childContext.map((message) => {
        const entry = {
          type: "message",
          id: randomUUID(),
          parentId,
          timestamp: new Date().toISOString(),
          message,
        };
        parentId = entry.id;
        return entry;
      });
      const body =
        [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
      durable(file, body, this.boundary);
      for (const path of [directory, this.root]) {
        const fd = openSync(path, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        this.boundary(
          path === directory
            ? "archive:directory-synced"
            : "archive:root-synced",
        );
      }
      const archive = {
        sessionId,
        file,
        sha256: createHash("sha256").update(body).digest("hex"),
        retentionDays: this.resources.policy.retentionMs / (24 * 60 * 60_000),
      };
      this.store.prepare(
        record.id,
        record.generation,
        archive,
        snapshot.file,
        snapshot.model,
        snapshot.thinkingLevel,
      );
      const receipt = {
        version: 2,
        provenance: "runtime-control",
        workstreamId: record.id,
        admissionId: normalized.admissionId,
        branchSessionId: sessionId,
      };
      const ids = this.owner.commit(
        normalized.parentSessionId,
        normalized.parentLeafId,
        [
          ...(!existingUserEntryId
            ? [
                {
                  type: "message",
                  message: userMessage,
                },
              ]
            : []),
          {
            type: "custom_message",
            customType: "familiar.background.admission-context",
            display: false,
            content: JSON.stringify({
              ...receipt,
              type: "familiar.background.admission",
              meaning:
                "The associated user request is delegated to this independent background workstream. Admission does not run a foreground model reply.",
            }),
          },
          {
            type: "custom",
            customType: "familiar.background-dispatch",
            data: receipt,
          },
        ],
      );
      this.store.admitReceipt(record.id, record.generation, {
        userEntryId: existingUserEntryId ?? ids[0],
        controlEntryId: ids.at(-1),
      });
      const task = new Promise((resolve) => setImmediate(resolve))
        .then(async () => {
          const before = this.store.get(record.id);
          if (this.closed || before.generation !== record.generation) {
            if (before.status === "cancelling")
              this.store.update(
                record.id,
                before.generation,
                "preparation-cancelled",
                (r) => {
                  r.status = "cancelled";
                },
              );
            return;
          }
          const runtime = await this.createRuntime(before, this);
          const current = this.store.get(record.id);
          if (this.closed || current.generation !== record.generation) {
            await runtime.abort();
            await runtime.dispose();
            const stopped = this.store.get(record.id);
            this.store.update(
              record.id,
              stopped.generation,
              "preparation-stopped",
              (r) => {
                r.preparationStopped = true;
                if (r.status === "cancelling") r.status = "cancelled";
              },
            );
            return;
          }
          this.scheduler.register(record.id, record.generation, runtime);
          this.scheduler.start(record.id, record.generation);
        })
        .catch((error) => {
          this.onError(error);
          const current = this.store.get(record.id);
          if (current && current.generation === record.generation)
            this.store.update(
              record.id,
              record.generation,
              "runtime-failed",
              (r) => {
                r.status = "orphaned";
                r.failure = "Runtime preparation failed; review required";
              },
            );
          this.onChange();
        })
        .finally(() => this.preparations.delete(record.id));
      this.preparations.set(record.id, task);
      return receipt;
    } catch (error) {
      // A committed canonical receipt is not undone. Recovery can inspect it,
      // but uncertain admissions are never automatically executed on restart.
      this.store.update(
        record.id,
        record.generation,
        "admission-failed",
        (r) => {
          r.status = "orphaned";
          r.failure = "Admission outcome requires review";
        },
      );
      throw error;
    }
  }
  steer(key, generation, commandId, content) {
    if (this.closed) throw new Error("host closed");
    if (this.scheduler.live.has(key))
      return this.scheduler.steer(key, generation, commandId, content);
    if (!this.preparations.has(key))
      throw new Error("branch writer unavailable");
    this.store.enqueue(key, generation, commandId, content);
    this.onChange();
    return { accepted: true, commandId };
  }
  cancel(key, generation) {
    if (this.closed) throw new Error("host closed");
    if (this.scheduler.live.has(key))
      return this.scheduler.cancel(key, generation, "operator cancellation");
    if (!this.preparations.has(key))
      throw new Error("branch writer unavailable; inspect quarantine");
    const record = this.store.cancel(key, generation, "operator cancellation");
    const timer = setTimeout(() => {
      if (!this.preparations.has(key)) return;
      const current = this.store.get(key);
      if (current?.status === "cancelling")
        this.store.update(
          key,
          current.generation,
          "preparation-quarantined",
          (r) => {
            r.status = "orphaned";
            r.failure = "Cancelled preparation has not drained";
          },
        );
      this.onChange();
    }, this.scheduler.abortTimeoutMs);
    timer.unref?.();
    return { accepted: true, generation: record.generation };
  }
  async reconcileAndRelease(key, generation, backend) {
    const record = this.store.get(key);
    if (
      this.closed ||
      !record ||
      record.generation !== generation ||
      (record.status !== "orphaned" && !record.resourceQuarantined)
    )
      throw new Error("not quarantined");
    for (const child of record.children) {
      if (child.terminal) continue;
      const jobId =
        child.jobId ?? (await backend.lookupCreate(child.createKey))?.id;
      if (!jobId)
        throw new Error(
          "Uncertain child create remains quarantined; backend has not resolved its reference",
        );
      await backend.cancel(jobId);
      const job = await backend.status(jobId);
      if (
        this.closed ||
        job.id !== jobId ||
        !["done", "failed", "cancelled", "timeout"].includes(job.state) ||
        !job.settlement
      )
        throw new Error(
          "Child cancellation has not settled; retry inspection later",
        );
      this.store.update(key, generation, "child-retired", (r) => {
        const owned = r.children.find((c) => c.key === child.key);
        owned.jobId = jobId;
        owned.terminal = true;
        owned.questionId = null;
        owned.pendingEvent = null;
      });
    }
    const lane = this.scheduler.live.get(key);
    if (
      lane &&
      !lane.stopped &&
      lane.runtime.verifyStopped &&
      (await lane.runtime.verifyStopped()) &&
      !lane.busy
    )
      lane.stopped = true;
    return this.releaseQuarantine(key, generation);
  }
  releaseQuarantine(key, generation) {
    if (this.closed) throw new Error("host closed");
    if (this.scheduler.live.has(key))
      return this.scheduler.releaseQuarantine(key, generation);
    const record = this.store.get(key);
    if (
      !record ||
      record.generation !== generation ||
      (record.status !== "orphaned" && !record.resourceQuarantined) ||
      this.preparations.has(key) ||
      record.children.some((c) => !c.terminal)
    )
      throw new Error("writer/backend retirement not proven");
    this.store.update(key, generation, "quarantine-release", (r) => {
      if (r.status === "orphaned") r.status = "cancelled";
      r.resourceQuarantined = false;
    });
    this.onChange();
  }
  flushRejoins() {
    if (
      this.closed ||
      !this.pendingRejoins ||
      (this.owner.available && !this.owner.available())
    )
      return;
    const snapshot = this.owner.snapshot();
    if (!snapshot.idle || snapshot.private) return;
    this.pendingRejoins = false;
    for (const record of this.store.list()) {
      const packet = record.packets.at(-1);
      if (
        record.status !== "running" ||
        record.settledRun !== record.run ||
        record.childWake ||
        !packet?.requestedRejoin ||
        ["progress", "blocked"].includes(packet.disposition) ||
        record.commands.some((c) => c.status !== "done") ||
        record.children.some(
          (c) => !c.terminal || c.questionId || c.pendingEvent,
        ) ||
        (packet.disposition === "ready" && packet.questions.length)
      )
        continue;
      this.rejoin(
        record.id,
        record.generation,
        packet.packetId,
        this.owner.snapshot().leafId,
      );
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
        this.store.update(key, generation, "parent-orphaned", (r) => {
          r.status = "orphaned";
          r.failure = "Canonical session changed";
        });
      throw new Error("parent session changed");
    }
    if (
      !snapshot.idle ||
      snapshot.private ||
      snapshot.leafId !== expectedLeafId
    )
      throw new Error("canonical merge conflict");
    if (
      !["running", "rejoining"].includes(record.status) ||
      record.generation !== generation
    )
      throw new Error("cannot rejoin or replay");
    const retire = () => {
      const lane = this.scheduler.live.get(key);
      if (lane && !lane.busy && !lane.retiring)
        this.scheduler.complete(key, generation);
    };
    if (this.scheduler.live.get(key)?.busy)
      throw new Error("branch not settled");
    if (record.status === "running") this.store.assertRejoin(record, packetId);
    else {
      if (record.selectedPacketId !== packetId)
        throw new Error("selected packet conflict");
      if (this.hasPacket(record, packetId)) {
        this.store.delivered(key, generation, packetId);
        this.onChange();
        retire();
        return { packetId, reconciled: true };
      }
    }
    if (record.archive.file !== join(this.root, record.id, "branch.jsonl"))
      throw new Error("archive escaped owner root");
    const archiveStat = lstatSync(record.archive.file);
    if (
      !archiveStat.isFile() ||
      archiveStat.isSymbolicLink() ||
      archiveStat.size > 32 * 1024 * 1024
    )
      throw new Error("unsafe or oversized archive");
    const archiveFd = openSync(record.archive.file, "r");
    try {
      fsyncSync(archiveFd);
    } finally {
      closeSync(archiveFd);
    }
    const bytes = readFileSync(record.archive.file);
    const lines = bytes.toString("utf8").trimEnd().split("\n");
    const header = JSON.parse(lines.shift());
    if (
      header.type !== "session" ||
      header.id !== record.archive.sessionId ||
      header.version !== 3
    )
      throw new Error("archive identity conflict");
    for (const line of lines) JSON.parse(line);
    this.store.update(key, generation, "archive-sealed", (r) => {
      r.archive.sha256 = createHash("sha256").update(bytes).digest("hex");
    });
    const selected =
      record.status === "running"
        ? this.store.beginRejoin(key, generation, packetId)
        : this.store.get(key);
    const packet = selected.packets.find((p) => p.packetId === packetId);
    const content = mergeContent(selected, packet, expectedLeafId);
    try {
      this.owner.commit(snapshot.sessionId, expectedLeafId, [
        {
          type: "custom_message",
          customType: "familiar.background.merge",
          content,
          display: true,
          details: { packetId, workstreamId: key },
        },
      ]);
      this.store.delivered(key, generation, packetId);
      this.onChange();
      return { packetId };
    } catch (error) {
      // Keep delivery intent. A healthy owner can retry or reconcile by complete
      // packet identity; a post-rename poisoned writer requires a new birth.
      try {
        this.store.update(key, generation, "delivery-pending", (r) => {
          r.failure =
            "Canonical delivery pending; retry rejoin with a healthy owner or recover under a new birth";
        });
      } catch {
        /* preserve the original I/O failure */
      }
      throw error;
    } finally {
      retire();
    }
  }
  inspect(key) {
    const r = this.store.get(key);
    if (!r) throw new Error("unknown workstream");
    // Inspection intentionally projects reports/owned children, not a transcript.
    return {
      id: r.id,
      generation: r.generation,
      status: r.status,
      projectId: r.admission.projectId,
      sessionId: r.admission.parentSessionId,
      packets: r.packets,
      children: r.children,
      archiveSessionId: r.archive?.sessionId,
      resourceQuarantined: Boolean(r.resourceQuarantined),
      failure: r.failure ?? r.cancelReason,
    };
  }
  async shutdown() {
    this.closed = true;
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([...this.preparations.values()]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.scheduler.abortTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const preparing = [...this.preparations.keys()];
    for (const key of preparing) {
      const record = this.store.get(key);
      if (record && record.status === "running")
        this.store.update(
          key,
          record.generation,
          "preparation-quarantined",
          (r) => {
            r.generation++;
            r.status = "orphaned";
            r.failure =
              "Runtime construction did not drain; writer quarantined";
          },
        );
    }
    const result = await this.scheduler.shutdown();
    result.quarantined.push(...preparing);
    if (result.quarantined.length === 0) this.store.close();
    return result;
  }
}
