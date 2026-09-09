import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkstreamStore } from "./store.mjs";
import { admission, LIMITS, mergeContent } from "./protocol.mjs";

const request = {
  admissionId: "admission-1",
  parentSessionId: "parent",
  parentLeafId: "leaf",
  projectId: "project",
  content: "exact admitted turn\n",
};
const packet = {
  reportId: "report-1",
  disposition: "ready",
  summary: "summary",
  decisions: ["decision"],
  durableContext: ["context"],
  risks: ["risk"],
  changedArtifacts: ["artifact"],
  integrationRef: "commit",
  requestedRejoin: true,
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "background-store-"));
  const store = new WorkstreamStore(root);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store };
}
function running(store) {
  const r = store.create(request).record;
  store.prepare(r.id, 1, {
    file: "/synthetic/branch.jsonl",
    sha256: "a".repeat(64),
    sessionId: "branch",
  });
  store.admitReceipt(r.id, 1, {
    userEntryId: "user",
    controlEntryId: "control",
  });
  store.start(r.id, 1);
  return store.get(r.id);
}

test("admission single identity binds exact bytes, parent and project", (t) => {
  const { store } = fixture(t);
  const first = store.create(request);
  assert.equal(first.created, true);
  assert.equal(store.create({ ...request }).record.id, first.record.id);
  for (const changed of [
    { content: request.content.trim() },
    { parentSessionId: "other" },
    { parentLeafId: null },
    { projectId: "other" },
  ])
    assert.throws(
      () => store.create({ ...request, ...changed }),
      /replay conflict/,
    );
  assert.equal(store.list().length, 1);
});

test("report transaction dedupes, rejects changes, and carries complete typed model content", (t) => {
  const { store } = fixture(t);
  const r = running(store);
  const saved = store.saveReport(r.id, 1, packet);
  assert.deepEqual(store.saveReport(r.id, 1, packet), saved);
  assert.throws(
    () => store.saveReport(r.id, 1, { ...packet, risks: ["new"] }),
    /replay conflict/,
  );
  const envelope = JSON.parse(mergeContent(store.get(r.id), saved, "new-leaf"));
  for (const field of [
    "decisions",
    "durableContext",
    "risks",
    "changedArtifacts",
    "integrationRef",
  ])
    assert.deepEqual(envelope[field], packet[field]);
  assert.equal(envelope.archive.file, "/synthetic/branch.jsonl");
  assert.equal(envelope.provenance, "broker-merge");
  assert.equal(envelope.staleParent, true);
});

test("settlement belongs to exact run; first valid rejoin wins and replay rejects", (t) => {
  const { store } = fixture(t);
  const r = running(store);
  let p = store.saveReport(r.id, 1, packet);
  assert.throws(() => store.beginRejoin(r.id, 1, p.packetId), /not settled/);
  store.settle(r.id, 1, 1);
  store.start(r.id, 1);
  assert.throws(() => store.settle(r.id, 1, 1), /stale settlement/);
  assert.throws(() => store.beginRejoin(r.id, 1, p.packetId), /superseded/);
  p = store.saveReport(r.id, 1, { ...packet, reportId: "second" });
  store.settle(r.id, 1, 2);
  store.beginRejoin(r.id, 1, p.packetId);
  assert.throws(() => store.beginRejoin(r.id, 1, p.packetId), /replay/);
  store.delivered(r.id, 1, p.packetId);
  assert.throws(() => store.delivered(r.id, 1, p.packetId), /receipt/);
});

test("refusal, narrowing and immediate return require honest settled writer", (t) => {
  for (const disposition of ["refused", "narrowed", "returned"]) {
    const { store } = fixture(t);
    const r = running(store);
    const p = store.saveReport(r.id, 1, {
      ...packet,
      disposition,
      questions: ["Returned to foreground for scope decision"],
    });
    assert.throws(() => store.beginRejoin(r.id, 1, p.packetId), /settled/);
    store.settle(r.id, 1, 1);
    store.beginRejoin(r.id, 1, p.packetId);
  }
});

test("steering clears settlement and pending commands prevent rejoin", (t) => {
  const { store } = fixture(t);
  const r = running(store);
  const p = store.saveReport(r.id, 1, packet);
  store.settle(r.id, 1, 1);
  store.enqueue(r.id, 1, "steering", "new direction");
  store.enqueue(r.id, 1, "steering", "new direction");
  assert.equal(store.get(r.id).commands.length, 1);
  assert.throws(
    () => store.enqueue(r.id, 1, "steering", "different"),
    /conflict/,
  );
  store.settle(r.id, 1, 1);
  assert.throws(() => store.beginRejoin(r.id, 1, p.packetId), /settled/);
});

test("restart increments OLD generation once; second recovery cannot self-stale", (t) => {
  const { store } = fixture(t);
  const r = running(store);
  store.cancel(r.id, 1);
  assert.equal(store.get(r.id).generation, 2);
  store.recover(() => false);
  const recovered = store.get(r.id);
  assert.equal(recovered.generation, 3);
  assert.equal(recovered.status, "orphaned");
  store.recover(() => false);
  assert.deepEqual(store.get(r.id), recovered);
  assert.throws(() => store.saveReport(r.id, 1, packet), /stale/);
});

test("canonical append-before-receipt is reconciled without second append", (t) => {
  const { store } = fixture(t);
  const r = running(store);
  const p = store.saveReport(r.id, 1, packet);
  store.settle(r.id, 1, 1);
  store.beginRejoin(r.id, 1, p.packetId);
  store.recover(
    (record, selected) =>
      record.admission.parentSessionId === "parent" && selected === p.packetId,
  );
  assert.equal(store.get(r.id).deliveredPacketId, p.packetId);
  assert.equal(store.get(r.id).status, "rejoined");
});

test("aggregate bounds reject oversized context packets, images and registry growth", (t) => {
  const { store } = fixture(t);
  const r = running(store);
  assert.throws(
    () =>
      store.saveReport(r.id, 1, {
        ...packet,
        durableContext: Array(32).fill("x".repeat(2048)),
      }),
    /budget/,
  );
  assert.throws(
    () => admission({ ...request, content: "x".repeat(LIMITS.admissionBytes) }),
    /budget/,
  );
  assert.throws(
    () =>
      admission({
        ...request,
        content: [{ type: "image", mimeType: "image/png", data: "!invalid!" }],
      }),
    /image/,
  );
  for (let n = 1; n < LIMITS.active; n++)
    store.create({ ...request, admissionId: `other-${n}` });
  assert.throws(
    () => store.create({ ...request, admissionId: "over-limit" }),
    /quota/,
  );
});

test("attachment/image and bounded project handoff survive byte-exact normalization", () => {
  const content = [
    {
      type: "text",
      text: 'task\n<project-handoff>{"projectId":"p"}</project-handoff>\nattachment: /durable/file',
    },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ];
  assert.deepEqual(admission({ ...request, content }).content, content);
});

// These are real process kills, not simulated exceptions or durable-prefix
// fixtures. Every SQLite mutation is killed after write, before commit and
// after FULL commit. Recovery may preserve or discard the transaction, never
// a split admission/index/report/receipt. No provider or Pi process is spawned.
const stages = [
  "admit",
  "prepare",
  "admit-receipt",
  "start",
  "steer",
  "settle",
  "report",
  "rejoin",
  "delivered",
  "cancel",
  "recover",
  "command-start",
  "command-done",
  "child-intent",
  "child-receipt",
  "child-event",
  "child-answer",
  "child-event-ack",
  "retire",
  "retire-error",
];
for (const stage of stages)
  for (const edge of ["written", "before-commit", "after-commit"]) {
    test(`SIGKILL/restart at ${stage}:${edge}`, (t) => {
      const { root, store } = fixture(t);
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("crash-worker.mjs", import.meta.url)),
          root,
          `${stage}:${edge}`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.signal, "SIGKILL", result.stderr);
      let all = store.list();
      assert.ok(all.length <= 1);
      const retry = store.create(request).record;
      assert.equal(store.list().length, 1);
      if (all.length) assert.equal(retry.id, all[0].id);
      store.recover(() => false);
      all = store.list();
      assert.ok(["orphaned", "rejoined", "cancelled"].includes(all[0].status));
      store.recover(() => false);
      assert.equal(store.list()[0].generation, all[0].generation);
    });
  }
