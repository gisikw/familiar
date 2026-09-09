import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkstreamStore } from "./store.mjs";
import { BranchScheduler } from "./scheduler.mjs";
import { OwnedChildren } from "./children.mjs";
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function setup(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "background-scheduler-"));
  const store = new WorkstreamStore(root);
  const scheduler = new BranchScheduler(store, {
    abortTimeoutMs: 20,
    ...options,
  });
  t.after(async () => {
    await scheduler.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  function branch(n, runtime = {}) {
    const r = store.create({
      admissionId: `admit-${n}`,
      parentSessionId: "fg",
      parentLeafId: null,
      projectId: "project",
      content: `task-${n}`,
    }).record;
    store.prepare(r.id, 1, {
      file: `/synthetic/${n}.jsonl`,
      sessionId: `branch-${n}`,
      sha256: "a".repeat(64),
    });
    store.admitReceipt(r.id, 1, {
      userEntryId: `user-${n}`,
      controlEntryId: `control-${n}`,
    });
    scheduler.register(r.id, 1, {
      sessionId: `branch-${n}`,
      file: `/synthetic/${n}.jsonl`,
      run: async () => {},
      abort: async () => {},
      dispose() {},
      ...runtime,
    });
    return r;
  }
  return { store, scheduler, branch };
}

test("two held turns, steering and slow abort never delay unrelated foreground admission", async (t) => {
  const { scheduler, branch } = setup(t);
  const a = deferred(),
    b = deferred(),
    abort = deferred();
  let started = 0;
  const ra = branch(1, {
    run: () => {
      started++;
      return a.promise;
    },
    abort: () => abort.promise,
  });
  const rb = branch(2, {
    run: () => {
      started++;
      return b.promise;
    },
  });
  assert.deepEqual(scheduler.start(ra.id, 1), { accepted: true });
  scheduler.start(rb.id, 1);
  await tick();
  assert.equal(started, 2);
  let gate = Promise.resolve();
  const dispatch = (fn) => (gate = gate.then(fn));
  await dispatch(() => scheduler.steer(ra.id, 1, "steer", "direction"));
  await dispatch(() => scheduler.cancel(ra.id, 1, "cancel"));
  let foreground = false;
  await dispatch(() => {
    foreground = true;
  });
  assert.equal(foreground, true);
  a.resolve();
  b.resolve();
  abort.resolve();
  await tick();
});

test("queued steering starts a new run; stale settlement is never reusable", async (t) => {
  const { scheduler, store, branch } = setup(t);
  const first = deferred();
  const second = deferred();
  let count = 0;
  const r = branch(1, {
    run: () => (++count === 1 ? first.promise : second.promise),
  });
  scheduler.start(r.id, 1);
  await tick();
  scheduler.steer(r.id, 1, "new", "next");
  first.resolve();
  await tick();
  await tick();
  assert.equal(count, 2);
  assert.equal(store.get(r.id).settledRun, null);
  second.resolve();
  await tick();
  assert.equal(store.get(r.id).settledRun, 2);
  assert.equal(store.get(r.id).commands[0].status, "done");
});

test("abort deadline quarantines live writer and teardown is bounded", async (t) => {
  const { scheduler, store, branch } = setup(t);
  let disposed = false;
  const r = branch(1, {
    run: () => new Promise(() => {}),
    abort: () => new Promise(() => {}),
    dispose() {
      disposed = true;
    },
  });
  scheduler.start(r.id, 1);
  await tick();
  const outcome = await scheduler.shutdown();
  assert.deepEqual(outcome.quarantined, [r.id]);
  assert.equal(disposed, false);
  assert.equal(store.get(r.id).status, "orphaned");
  assert.throws(() => scheduler.steer(r.id, 1, "late", "late"), /unavailable/);
});

test("turn deadline and idle deadline fence work without foreground participation", async (t) => {
  const { scheduler, store, branch } = setup(t, {
    turnTimeoutMs: 15,
    idleTimeoutMs: 15,
  });
  const a = branch(1, { run: () => new Promise(() => {}) });
  const b = branch(2);
  scheduler.start(a.id, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.get(a.id).status, "orphaned");
  assert.equal(store.get(b.id).status, "cancelled");
});

test("Golem dispatch intent survives timeout and uses one service idempotency key", async (t) => {
  const { store, branch } = setup(t);
  const r = branch(1);
  let calls = 0;
  const keys = [];
  const client = {
    dispatch: async (p) => {
      keys.push(p.idempotency_key);
      if (++calls === 1) throw new Error("timeout");
      return { id: "job", state: "running" };
    },
  };
  const owned = new OwnedChildren(store, r.id, 1, client);
  await assert.rejects(owned.dispatch("create", { prompt: "task" }), /timeout/);
  await owned.dispatch("create", { prompt: "task" });
  assert.equal(keys[0], keys[1]);
  assert.equal(store.get(r.id).children.length, 1);
  await assert.rejects(
    owned.dispatch("create", { prompt: "changed" }),
    /conflict/,
  );
});

test("child questions, answers and settlements remain branch-local and block premature rejoin", async (t) => {
  const { store, branch } = setup(t);
  const a = branch(1),
    b = branch(2);
  let job = { id: "job", state: "running" };
  let answered;
  const client = {
    dispatch: async () => job,
    status: async () => job,
    answer: async (_id, body) => {
      answered = body;
      return {};
    },
  };
  const owned = new OwnedChildren(store, a.id, 1, client),
    foreign = new OwnedChildren(store, b.id, 1, client);
  await owned.dispatch("create", { prompt: "task" });
  job = {
    ...job,
    state: "blocked",
    question: { id: "question", prompt: "choose" },
  };
  assert.equal(await foreign.observe({ seq: 1, job_id: "job" }), false);
  assert.equal(await owned.observe({ seq: 1, job_id: "job" }), true);
  assert.equal(await owned.observe({ seq: 1, job_id: "job" }), false);
  await assert.rejects(
    foreign.answer("job", "question", "answer", "yes"),
    /not owned/,
  );
  await owned.answer("job", "question", "answer", "yes");
  assert.equal(answered.question_id, "question");
  job = {
    id: "job",
    state: "done",
    settlement: { state: "done", verdict: "done" },
  };
  await owned.observe({ seq: 2, job_id: "job" });
  const p = store.saveReport(a.id, 1, {
    reportId: "ready",
    disposition: "ready",
    summary: "result",
    requestedRejoin: true,
  });
  store.settle(a.id, 1, 0);
  assert.throws(() => store.beginRejoin(a.id, 1, p.packetId), /settled/);
  assert.throws(() => owned.acknowledgeEvent("job", 1), /stale/);
  owned.acknowledgeEvent("job", 2);
  store.beginRejoin(a.id, 1, p.packetId);
});

test("cancellation during dispatch cancels the returned exact job without claiming new generation", async (t) => {
  const { store, branch, scheduler } = setup(t);
  const r = branch(1),
    wait = deferred();
  let cancelled;
  const owned = new OwnedChildren(store, r.id, 1, {
    dispatch: () => wait.promise,
    cancel: async (job) => {
      cancelled = job;
    },
  });
  const dispatch = owned.dispatch("create", { prompt: "task" });
  scheduler.cancel(r.id, 1, "cancel");
  wait.resolve({ id: "job", state: "running" });
  await assert.rejects(dispatch, /stale/);
  assert.equal(cancelled, "job");
  assert.equal(store.get(r.id).children[0].jobId, null);
});
