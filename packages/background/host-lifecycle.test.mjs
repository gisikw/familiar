import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BackgroundHost } from "./host.mjs";
import { WorkstreamStore } from "./store.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(createRuntime) {
  const root = mkdtempSync(join(tmpdir(), "host-lifecycle-"));
  let leafId = null;
  const owner = {
    snapshot: () => ({
      sessionId: "parent",
      leafId,
      cwd: root,
      model: { provider: "fixture", id: "model" },
      thinkingLevel: "medium",
      idle: true,
      private: false,
      entries: [],
      messages: [],
    }),
    commit: (_session, leaf, inputs) => {
      assert.equal(leaf, leafId);
      const ids = inputs.map(() => randomUUID());
      leafId = ids.at(-1);
      return ids;
    },
  };
  const host = new BackgroundHost({ root, owner, createRuntime });
  host.scheduler.abortTimeoutMs = 20;
  const admit = (name) =>
    host.admit({
      admissionId: name,
      parentSessionId: "parent",
      parentLeafId: leafId,
      projectId: "project",
      content: "exact",
    });
  return { root, host, admit };
}

test("host startup recovers valid v3 work while mixed invalid rows remain fenced", async () => {
  const root = mkdtempSync(join(tmpdir(), "host-mixed-quarantine-"));
  let seed = new WorkstreamStore(root);
  const valid = seed.create({
    admissionId: "valid-before-restart",
    parentSessionId: "parent",
    parentLeafId: null,
    projectId: "project",
    content: "valid persisted work",
  }).record;
  seed.prepare(
    valid.id,
    valid.generation,
    {
      file: "/synthetic/valid.jsonl",
      sha256: "e".repeat(64),
      sessionId: "valid-branch",
    },
    undefined,
    { provider: "fixture", id: "model" },
    "medium",
  );
  seed.admitReceipt(valid.id, valid.generation, {
    userEntryId: "valid-user",
    controlEntryId: "valid-control",
  });
  const source = seed.get(valid.id);
  const invalid = [];
  const insert = (name, mutate, encoded) => {
    const record = structuredClone(source);
    record.id = `invalid-${name}`;
    record.admission.admissionId = `fenced-${name}`;
    mutate?.(record);
    const body = encoded ?? JSON.stringify(record);
    seed.db
      .prepare("INSERT INTO workstreams VALUES (?,?,?,?,?)")
      .run(
        record.id,
        record.admission.admissionId,
        record.admission.digest,
        record.revision,
        body,
      );
    invalid.push({
      id: record.id,
      admissionId: record.admission.admissionId,
      body,
    });
  };
  insert("json", null, "{");
  insert("v2", (record) => {
    record.version = 2;
  });
  insert("thinking", (record) => {
    delete record.thinkingLevel;
  });
  insert("model", (record) => {
    delete record.model;
  });
  seed.close();

  let leafId = null;
  let commits = 0;
  let factories = 0;
  let runs = 0;
  const owner = {
    snapshot: () => ({
      sessionId: "parent",
      leafId,
      cwd: root,
      model: { provider: "fixture", id: "model" },
      thinkingLevel: "high",
      idle: true,
      private: false,
      entries: [],
      messages: [],
    }),
    commit: (_session, leaf, inputs) => {
      assert.equal(leaf, leafId);
      commits++;
      const ids = inputs.map(() => randomUUID());
      leafId = ids.at(-1);
      return ids;
    },
  };
  const host = new BackgroundHost({
    root,
    owner,
    createRuntime: async (record) => {
      factories++;
      return {
        sessionId: record.archive.sessionId,
        file: record.archive.file,
        async run() {
          runs++;
        },
        async abort() {},
        async dispose() {},
      };
    },
  });
  try {
    assert.equal(host.store.get(valid.id).status, "orphaned");
    assert.deepEqual(
      host.store.list().map((record) => record.id),
      [valid.id],
    );
    assert.equal(host.store.quarantineList().length, invalid.length);
    assert.equal(factories, 0, "recovery never constructed invalid work");
    assert.throws(
      () =>
        host.admit({
          admissionId: invalid[0].admissionId,
          parentSessionId: "parent",
          parentLeafId: leafId,
          projectId: "project",
          content: "must remain deduplicated",
        }),
      /quarantined workstream record/,
    );
    assert.equal(commits, 0);
    const receipt = host.admit({
      admissionId: "fresh-after-quarantine",
      parentSessionId: "parent",
      parentLeafId: leafId,
      projectId: "project",
      content: "unrelated valid work",
    });
    for (let index = 0; index < 5; index++) await tick();
    assert.equal(factories, 1);
    assert.equal(runs, 1);
    assert.equal(host.store.get(receipt.workstreamId).thinkingLevel, "high");
    for (const row of invalid)
      assert.equal(
        host.store.db
          .prepare("SELECT body FROM workstreams WHERE id=?")
          .get(row.id).body,
        row.body,
      );
  } finally {
    await host.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancellation before deferred creation prevents any factory or model effect", async () => {
  let factories = 0;
  const { root, host, admit } = fixture(() => {
    factories++;
    throw new Error("must not run");
  });
  try {
    const receipt = admit("one");
    assert.equal(
      host.steer(
        receipt.workstreamId,
        1,
        "early-steer",
        "Exact steering while construction is queued",
      ).accepted,
      true,
    );
    assert.equal(
      host.store.get(receipt.workstreamId).commands[0].status,
      "queued",
    );
    host.cancel(receipt.workstreamId, 1);
    await tick();
    await tick();
    assert.equal(factories, 0);
    assert.equal(host.store.get(receipt.workstreamId).status, "cancelled");
  } finally {
    await host.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("slow preparation cancellation stays reserved until stopped, then explicit quarantine release succeeds", async () => {
  let resolveRuntime,
    disposed = 0,
    runs = 0;
  const { root, host, admit } = fixture(
    (record) =>
      new Promise((resolve) => {
        resolveRuntime = () =>
          resolve({
            sessionId: record.archive.sessionId,
            file: record.archive.file,
            async run() {
              runs++;
            },
            async abort() {},
            async dispose() {
              disposed++;
            },
          });
      }),
  );
  try {
    const receipt = admit("one");
    await tick();
    const started = Date.now();
    host.cancel(receipt.workstreamId, 1);
    assert.ok(Date.now() - started < 100);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const record = host.store.get(receipt.workstreamId);
    assert.equal(record.status, "orphaned");
    assert.throws(
      () => host.releaseQuarantine(record.id, record.generation),
      /not proven/,
    );
    resolveRuntime();
    await tick();
    await tick();
    assert.equal(runs, 0);
    assert.equal(disposed, 1);
    await host.reconcileAndRelease(record.id, record.generation, {});
    assert.equal(host.store.get(record.id).status, "cancelled");
  } finally {
    await host.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("shutdown construction deadline is finite and never frees an uncertain writer", async () => {
  let resolveRuntime;
  const { root, host, admit } = fixture(
    (record) =>
      new Promise((resolve) => {
        resolveRuntime = () =>
          resolve({
            sessionId: record.archive.sessionId,
            file: record.archive.file,
            async run() {},
            async abort() {},
            dispose() {},
          });
      }),
  );
  const receipt = admit("one");
  await tick();
  try {
    const start = Date.now();
    const outcome = await host.shutdown();
    assert.ok(Date.now() - start < 250);
    assert.deepEqual(outcome.quarantined, [receipt.workstreamId]);
    assert.equal(host.store.get(receipt.workstreamId).status, "orphaned");
    resolveRuntime();
    await tick();
    await tick();
    assert.equal(host.preparations.size, 0);
  } finally {
    host.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
