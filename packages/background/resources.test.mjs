import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourcePolicy } from "./resources.mjs";
import { WorkstreamStore } from "./store.mjs";

test("disk reservations bound future writers; retention never evicts live/uncertain archives and preserves admission tombstones", () => {
  const root = mkdtempSync(join(tmpdir(), "background-resources-"));
  const store = new WorkstreamStore(root);
  const policy = new ResourcePolicy(root, { branchBytes: 512, reservationBytes: 1024, archiveBytes: 2048, retentionMs: 10 });
  const create = (name, status) => {
    const { record } = store.create({ admissionId: name, parentSessionId: "parent", parentLeafId: null, projectId: "project", content: "exact" });
    mkdirSync(join(root, record.id));
    store.update(record.id, 1, "fixture", (r) => { r.status = status; r.archive = { file: join(root, record.id, "branch.jsonl"), sessionId: name, sha256: "0".repeat(64) }; });
    return store.get(record.id);
  };
  try {
    policy.admit();
    const done = create("done", "rejoined");
    policy.admit();
    const uncertain = create("uncertain", "orphaned");
    assert.throws(() => policy.admit(), /reservation quota/);
    assert.deepEqual(policy.collect(store, new Set([done.id]), Date.now() + 1000), []);
    assert.deepEqual(policy.collect(store, new Set(), Date.now() + 1000), [done.id]);
    assert.equal(existsSync(join(root, uncertain.id)), true);
    assert.equal(existsSync(join(root, done.id)), false);
    assert.equal(store.byAdmission("done").admission.digest, done.admission.digest);
    assert.equal(store.byAdmission("done").archive.expired, true);
    // Simulate a kill after the expiry transaction but before directory removal.
    mkdirSync(join(root, done.id));
    policy.collect(store);
    assert.equal(existsSync(join(root, done.id)), false);
    policy.admit();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
