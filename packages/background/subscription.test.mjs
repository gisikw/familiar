import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkstreamStore } from "./store.mjs";
import { OwnedChildren } from "./children.mjs";
import { ChildSubscription } from "./subscription.mjs";
import { LIMITS } from "./protocol.mjs";

test("answers, steers and cancellation intent commit before backend effects; uncertain steers never replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "child-intent-"));
  const store = new WorkstreamStore(root);
  const key = running(store, "intent");
  let steers = 0;
  const backend = {
    dispatch: async () => ({
      id: "child",
      state: "blocked",
      question: { id: "q", prompt: "Choose" },
    }),
    answer: async () => {
      assert.equal(store.get(key).children[0].pendingAnswer.text, "safe");
      return {};
    },
    steer: async () => {
      assert.equal(store.get(key).children[0].lastSteer.status, "uncertain");
      steers++;
      throw new Error("lost receipt");
    },
    cancel: async () => {
      assert.equal(store.get(key).children[0].cancellationRequested, true);
      return {};
    },
  };
  const children = new OwnedChildren(store, key, 1, backend);
  try {
    await children.dispatch("one", {});
    await children.answer("child", "q", "answer", "safe");
    assert.equal(children.owned("child").pendingAnswer, null);
    await assert.rejects(
      children.steer("child", "steer", "guide"),
      /lost receipt/,
    );
    await assert.rejects(
      children.steer("child", "steer", "guide"),
      /uncertain/,
    );
    await assert.rejects(
      children.steer("child", "different", "guide"),
      /uncertain/,
    );
    assert.equal(steers, 1);
    await children.cancel("child");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("total child references remain bounded even when every backend job immediately settles", async () => {
  const root = mkdtempSync(join(tmpdir(), "child-total-"));
  const store = new WorkstreamStore(root);
  let creates = 0;
  const children = new OwnedChildren(store, running(store, "total"), 1, {
    dispatch: async () => ({
      id: `job-${++creates}`,
      state: "done",
      settlement: { summary: "done" },
    }),
  });
  try {
    for (let n = 0; n < LIMITS.children; n++)
      await children.dispatch(`child-${n}`, {});
    await assert.rejects(children.dispatch("overflow", {}), /child quota/);
    assert.equal(creates, LIMITS.children);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("public projection cache never reads admission bodies and is rebuilt from committed truth", () => {
  const root = mkdtempSync(join(tmpdir(), "child-public-cache-"));
  const store = new WorkstreamStore(root);
  try {
    const { record } = store.create({
      admissionId: "private-payload",
      parentSessionId: "parent",
      parentLeafId: null,
      projectId: "project",
      content: "not-in-public-cache",
    });
    const prepare = store.db.prepare;
    store.db.prepare = () => {
      throw new Error("UI projection must not read SQLite");
    };
    const views = store.publicList("parent");
    assert.equal(views[0].id, record.id);
    assert.ok(Object.isFrozen(views[0]));
    assert.ok(!JSON.stringify(views).includes("not-in-public-cache"));
    assert.deepEqual(store.publicList("another-session"), []);
    store.db.prepare = prepare;
    store.update(record.id, 1, "cache-change", (r) => {
      r.status = "orphaned";
    });
    assert.equal(store.publicList("parent")[0].status, "orphaned");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function running(store, name) {
  const { record } = store.create({
    admissionId: name,
    parentSessionId: "parent",
    parentLeafId: null,
    projectId: "project",
    content: "exact",
  });
  store.prepare(record.id, 1, {
    file: `/tmp/${name}.jsonl`,
    sessionId: name,
    sha256: "0".repeat(64),
  });
  store.admitReceipt(record.id, 1, {
    userEntryId: "user",
    controlEntryId: "control",
  });
  return record.id;
}

test("global child reservations include uncertain creates across branches and never exceed the cap", async () => {
  const root = mkdtempSync(join(tmpdir(), "child-cap-"));
  const store = new WorkstreamStore(root);
  let creates = 0;
  const backend = {
    dispatch: async () => {
      creates++;
      throw new Error("uncertain");
    },
  };
  const a = new OwnedChildren(store, running(store, "a"), 1, backend);
  const b = new OwnedChildren(store, running(store, "b"), 1, backend);
  try {
    for (let n = 0; n < LIMITS.activeChildren; n++)
      await assert.rejects(
        (n % 2 ? a : b).dispatch(`child${n}`, {}),
        /uncertain/,
      );
    await assert.rejects(a.dispatch("overflow", {}), /reservation quota/);
    assert.equal(creates, LIMITS.activeChildren);
    assert.equal(
      store.list().flatMap((r) => r.children).length,
      LIMITS.activeChildren,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("subscription coalesces, retries detail failures, rejects foreign questions and preserves child review ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "child-subscription-"));
  const store = new WorkstreamStore(root);
  const key = running(store, "branch");
  let failing = false,
    reads = 0,
    wakes = 0;
  const backend = {
    dispatch: async () => ({ id: "child", state: "running" }),
    status: async () => {
      reads++;
      if (failing) throw new Error("offline");
      return {
        id: "child",
        state: "blocked",
        question: { id: "q", prompt: "Which target?" },
      };
    },
  };
  const children = new OwnedChildren(store, key, 1, backend);
  const subscription = new ChildSubscription(
    store,
    {
      live: new Map([[key, { generation: 1, runtime: { children } }]]),
      wakeChildren: () => {
        wakes++;
      },
    },
    backend,
    { retryMs: 5 },
  );
  try {
    await children.dispatch("one", {});
    reads = 0;
    failing = true;
    for (let seq = 1; seq < 1000; seq++)
      subscription.accept({ job_id: "foreign", seq });
    assert.equal(reads, 0);
    for (let seq = 1; seq <= 100; seq++)
      subscription.accept({ job_id: "child", seq });
    assert.equal(subscription.pending.size, 1);
    failing = false;
    for (let n = 0; n < 100 && subscription.pending.size; n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(subscription.pending.size, 0);
    assert.equal(children.owned("child").questionId, "q");
    assert.equal(children.owned("child").pendingEvent.seq, 100);
    assert.ok(wakes > 0 && wakes <= 2);
    assert.throws(() => children.owned("foreign"), /not owned/);
    assert.throws(() => children.acknowledgeEvent("child", 1), /stale/);
    children.acknowledgeEvent("child", 100);
    assert.equal(children.owned("child").pendingEvent, null);
  } finally {
    await subscription.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
