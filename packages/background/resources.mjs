import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL } from "./store.mjs";

export const RESOURCE_POLICY = Object.freeze({
  branchBytes: 32 * 1024 * 1024,
  reservationBytes: 64 * 1024 * 1024,
  archiveBytes: 512 * 1024 * 1024,
  retentionMs: 14 * 24 * 60 * 60_000,
});

/** Reservations bound even concurrent writers at their allowed maximum, not
 * merely their current disk usage. Never evict an uncertain/live writer.
 * Durable admission tombstones remain in SQLite so GC cannot enable replay.
 */
export class ResourcePolicy {
  constructor(root, policy = RESOURCE_POLICY) {
    for (const value of Object.values(policy)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid resource policy");
    if (policy.branchBytes > policy.reservationBytes || policy.reservationBytes > policy.archiveBytes) throw new Error("invalid resource reservation");
    this.root = root;
    this.policy = policy;
  }
  directories() {
    return readdirSync(this.root).filter((name) => {
      const stat = lstatSync(join(this.root, name));
      if (stat.isSymbolicLink()) throw new Error("unsafe resource symlink");
      return stat.isDirectory();
    });
  }
  admit() {
    if ((this.directories().length + 1) * this.policy.reservationBytes > this.policy.archiveBytes)
      throw new Error("archive reservation quota reached");
  }
  collect(store, liveKeys = new Set(), now = Date.now()) {
    const removed = [];
    for (const record of store.list()) {
      if (!TERMINAL.has(record.status) || record.status === "orphaned" || liveKeys.has(record.id) ||
        (!record.archive?.expired && now - record.updatedAt < this.policy.retentionMs)) continue;
      // Unreviewed uncertain children must remain visible even after host death.
      if (record.children.some((child) => !child.terminal)) continue;
      if (!record.archive?.expired) store.update(record.id, record.generation, "archive-expire", (r) => {
        if (r.archive) r.archive.expired = true;
        r.admission.content = "[expired archive]";
        r.commands = [];
        r.packets = [];
      });
      rmSync(join(this.root, record.id), { recursive: true, force: true });
      removed.push(record.id);
    }
    return removed;
  }
}
