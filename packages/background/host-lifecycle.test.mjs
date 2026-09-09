import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BackgroundHost } from "./host.mjs";
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
