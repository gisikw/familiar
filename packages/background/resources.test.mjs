import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourcePolicy } from "./resources.mjs";
import { WorkstreamStore } from "./store.mjs";

test("sealed archives pay actual bytes; active or uncertain writers retain their full reservation", () => {
  const root = mkdtempSync(join(tmpdir(), "background-sealed-"));
  const policy = new ResourcePolicy(root, {
    branchBytes: 512,
    reservationBytes: 1024,
    archiveBytes: 2048,
    retentionMs: 10,
  });
  const records = ["a", "b", "c"].map((id) => ({ id, status: "rejoined" }));
  try {
    for (const record of records) {
      mkdirSync(join(root, record.id));
      writeFileSync(join(root, record.id, "archive"), "x".repeat(128));
    }
    const store = { list: () => records };
    policy.admit(store);
    assert.throws(
      () => policy.admit(store, new Set(["a"])),
      /reservation quota/,
    );
    records[0].status = "orphaned";
    assert.throws(() => policy.admit(store), /reservation quota/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an external reader cannot make the WAL grow across mutations", () => {
  const root = mkdtempSync(join(tmpdir(), "background-wal-"));
  const store = new WorkstreamStore(root);
  const { record } = store.create({
    admissionId: "journal",
    parentSessionId: "parent",
    parentLeafId: null,
    projectId: "project",
    content: "exact",
  });
  const reader = new DatabaseSync(join(root, "workstreams.sqlite"), {
    readOnly: true,
  });
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT body FROM workstreams").get();
    const before = statSync(join(root, "workstreams.sqlite-wal")).size;
    assert.throws(
      () =>
        store.update(record.id, 1, "blocked", (r) => {
          r.test = "x";
        }),
      /checkpoint busy/,
    );
    assert.equal(statSync(join(root, "workstreams.sqlite-wal")).size, before);
    assert.equal(store.get(record.id).test, undefined);
    reader.exec("COMMIT");
    for (let n = 0; n < 20; n++) {
      store.update(record.id, 1, "bounded-wal", (r) => {
        r.test = String(n).repeat(100000);
      });
      assert.ok(
        statSync(join(root, "workstreams.sqlite-wal")).size < 1024 * 1024,
      );
    }
  } finally {
    reader.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("disk reservations bound future writers; retention never evicts live/uncertain archives and preserves admission tombstones", () => {
  const root = mkdtempSync(join(tmpdir(), "background-resources-"));
  const store = new WorkstreamStore(root);
  const policy = new ResourcePolicy(root, {
    branchBytes: 512,
    reservationBytes: 1024,
    archiveBytes: 2048,
    retentionMs: 10,
  });
  const create = (name, status) => {
    const { record } = store.create({
      admissionId: name,
      parentSessionId: "parent",
      parentLeafId: null,
      projectId: "project",
      content: "exact",
    });
    mkdirSync(join(root, record.id));
    store.update(record.id, 1, "fixture", (r) => {
      r.status = status;
      r.archive = {
        file: join(root, record.id, "branch.jsonl"),
        sessionId: name,
        sha256: "0".repeat(64),
      };
    });
    return store.get(record.id);
  };
  try {
    policy.admit();
    const done = create("done", "rejoined");
    policy.admit();
    const uncertain = create("uncertain", "orphaned");
    assert.throws(() => policy.admit(), /reservation quota/);
    assert.deepEqual(
      policy.collect(store, new Set([done.id]), Date.now() + 1000),
      [],
    );
    assert.deepEqual(policy.collect(store, new Set(), Date.now() + 1000), [
      done.id,
    ]);
    assert.equal(existsSync(join(root, uncertain.id)), true);
    assert.equal(existsSync(join(root, done.id)), false);
    assert.equal(
      store.byAdmission("done").admission.digest,
      done.admission.digest,
    );
    assert.equal(store.byAdmission("done").archive.expired, true);
    // Simulate a kill after the expiry transaction but before directory removal.
    mkdirSync(join(root, done.id));
    policy.collect(store);
    assert.equal(existsSync(join(root, done.id)), false);
    policy.admit();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
