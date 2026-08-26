import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SettlementRelay, buildEnvelope, safeJobId, type JobDetail, type RelayClient } from "./relay.ts";
import { createCapabilityRegistry, WORKLIST_SINK, WORKLIST_SINK_VERSION, type DurableSink, type DurableEnqueueEnvelope, type DurableAcceptance } from "../../../../integrations/pi/extensions/lib/capabilities.ts";

/* A durable sink test double: records enqueues and dedupes on id, like worklist. */
function fakeSink() {
  const seen = new Map<string, DurableEnqueueEnvelope>();
  const sink: DurableSink = {
    async enqueue(env: DurableEnqueueEnvelope): Promise<DurableAcceptance> {
      const id = env.id ?? `mint-${seen.size}`;
      if (!seen.has(id)) seen.set(id, env);
      return { accepted: true, id };
    },
    async withdraw() { return true; },
  };
  return { sink, seen };
}

/* A controllable Golem client double. `jobs` maps id→detail; `events` is an
 * array of SSE frames fed to whoever streams. streamEvents resolves when the
 * (pre-seeded) frames are drained OR on abort — modelling a stream that returns
 * (disconnects) so the relay's reconnect loop is exercised. */
function fakeClient(opts: { keepStreamOpen?: boolean } = {}) {
  const jobs = new Map<string, JobDetail>();
  let pending: { seq?: number; job_id?: string; state?: string }[] = [];
  const statusCalls: string[] = [];
  let sinceSeen = -1;
  const client: RelayClient & { push: (e: any) => void } = {
    async status(id: string) {
      statusCalls.push(id);
      const j = jobs.get(id);
      if (!j) throw new Error(`no job ${id}`);
      return j;
    },
    async list() { return [...jobs.values()]; },
    async streamEvents(since, onEvent, signal) {
      sinceSeen = since;
      for (const e of pending) { if (signal.aborted) break; onEvent(e); }
      pending = [];
      // keepStreamOpen models a HEALTHY-but-silent stream: it stays open (only
      // abort resolves it), so no disconnect-driven reconciliation ever fires.
      await new Promise<void>((r) => {
        const t = opts.keepStreamOpen ? undefined : setTimeout(r, 20);
        signal.addEventListener("abort", () => { if (t) clearTimeout(t); r(); }, { once: true });
      });
    },
    push(e) { pending.push(e); },
  };
  return { client, jobs, statusCalls, push: (e: any) => client.push(e), sinceSeen: () => sinceSeen };
}

const settled = (id: string, state = "done", verdict = "all good"): JobDetail => ({
  id, state, harness: "pi", model: "op/m", workspace: { project: "familiar", worktree: "wt" },
  settlement: { state, verdict, artifacts: [{ path: "out.txt", size: 12 }] },
  usage: { input: 10, output: 20 },
});

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

let dirs: string[] = [];
function newDir(): string { const d = mkdtempSync(path.join(tmpdir(), "relay-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

describe("settlement relay", () => {
  test("buildEnvelope: stable id, priority by outcome, useful body", () => {
    const ok = buildEnvelope("job-1", settled("job-1", "done", "green"));
    expect(ok.id).toBe("golem-settle-job-1");
    expect(ok.priority).toBe(2);
    expect(ok.body).toContain("job job-1 — done");
    expect(ok.body).toContain("verdict:");
    expect(ok.body).toContain("out.txt");
    expect(ok.body).toContain("usage:");
    const bad = buildEnvelope("job-2", settled("job-2", "failed", "boom"));
    expect(bad.priority).toBe(1); // failure is more urgent than success
    expect(safeJobId("weird/../id")).not.toContain("/");
  });

  test("buildEnvelope: prefers nested settlement.usage from golemd's live payload", () => {
    // Realistic golemd job payload: usage is nested UNDER settlement, not at top.
    const job: JobDetail = {
      id: "job-usage", state: "done", harness: "pi", model: "anthropic/claude",
      workspace: { project: "familiar", repo: "", ref: "", worktree: "feat-x", path: "/w/feat-x" },
      settlement: {
        state: "done", verdict: "implemented and tested",
        artifacts: [{ path: "diff.patch", size: 4096 }],
        worktree: { name: "feat-x", head: "deadbeefcafe1234", dirty: false },
        usage: { input_tokens: 12345, output_tokens: 6789, cost_usd: 0.42 },
      },
    };
    const env = buildEnvelope("job-usage", job);
    expect(env.body).toContain("usage:");
    expect(env.body).toContain("12345");
    expect(env.body).toContain("output_tokens");
    expect(env.body).toContain("diff.patch");
    // Top-level usage still works as a fallback when settlement.usage is absent.
    const legacy = buildEnvelope("j", { id: "j", state: "done", settlement: { state: "done" }, usage: { total: 7 } });
    expect(legacy.body).toContain("\"total\":7");
  });

  test("fast settlement race: recordDispatch reconciles a job already terminal", async () => {
    const { client, jobs } = fakeClient();
    const { sink, seen } = fakeSink();
    jobs.set("fast", settled("fast", "done", "instant"));
    const relay = new SettlementRelay({ client, stateDir: newDir(), resolveSink: () => sink });
    await relay.recordDispatch("fast"); // job already settled at registration
    expect(seen.has("golem-settle-fast")).toBe(true);
    await relay.stop();
  });

  test("no historical unrelated-job flood: only owned jobs surface", async () => {
    const { client, jobs, push } = fakeClient();
    const { sink, seen } = fakeSink();
    // Many historical jobs from other clients already terminal.
    for (let i = 0; i < 5; i++) jobs.set(`other-${i}`, settled(`other-${i}`));
    jobs.set("mine", settled("mine", "done", "ours"));
    const relay = new SettlementRelay({ client, stateDir: newDir(), resolveSink: () => sink, backoffMs: 1 });
    await relay.recordDispatch("mine"); // owned; immediately relayed (it is already terminal)
    await relay.start();
    // Replay history: events for jobs we never dispatched must NOT surface.
    for (let i = 0; i < 5; i++) push({ seq: i + 1, job_id: `other-${i}`, state: "done" });
    push({ seq: 10, job_id: "mine", state: "done" }); // already done → tombstoned, no dup
    await tick(120);
    await relay.stop();
    const ids = [...seen.keys()];
    expect(ids).toEqual(["golem-settle-mine"]);
  });

  test("SSE reconnect: a terminal event after a stream disconnect still settles", async () => {
    const { client, jobs, push } = fakeClient();
    const { sink, seen } = fakeSink();
    // Job is still running at dispatch time, so recordDispatch does NOT relay.
    jobs.set("j", { id: "j", state: "running" });
    const relay = new SettlementRelay({ client, stateDir: newDir(), resolveSink: () => sink, backoffMs: 1 });
    await relay.recordDispatch("j");
    expect(seen.size).toBe(0);
    await relay.start();
    await tick(60); // first stream segment drains + disconnects
    jobs.set("j", settled("j", "failed", "later"));
    push({ seq: 5, job_id: "j", state: "failed" });
    await tick(120);
    await relay.stop();
    expect(seen.has("golem-settle-j")).toBe(true);
  });

  test("polling fallback reconciles owned-unsettled after repeated stream failure", async () => {
    const jobs = new Map<string, JobDetail>();
    const { sink, seen } = fakeSink();
    let fails = 0;
    const client: RelayClient = {
      async status(id) { const j = jobs.get(id); if (!j) throw new Error("nf"); return j; },
      async list() { return [...jobs.values()]; },
      async streamEvents() { fails++; throw new Error("stream down"); },
    };
    jobs.set("p", { id: "p", state: "running" });
    const relay = new SettlementRelay({ client, stateDir: newDir(), resolveSink: () => sink, backoffMs: 1 });
    await relay.recordDispatch("p");
    seen.clear();
    await relay.start();
    // After a few failed stream attempts the loop reconciles owned jobs.
    jobs.set("p", settled("p", "timeout", "gave up"));
    await tick(150);
    await relay.stop();
    expect(fails).toBeGreaterThanOrEqual(3);
    expect(seen.has("golem-settle-p")).toBe(true);
  });

  test("sink unavailable then available: retain pending, no direct relay, flush on recovery", async () => {
    const { client, jobs } = fakeClient();
    let sinkRef: DurableSink | undefined;
    jobs.set("r", settled("r", "done", "retry me"));
    const stateDir = newDir();
    const relay = new SettlementRelay({ client, stateDir, resolveSink: () => sinkRef, backoffMs: 1 });
    await relay.recordDispatch("r"); // sink undefined → pending retained
    const pendingDir = path.join(stateDir, "pending");
    expect(readdirSync(pendingDir).length).toBe(1); // retained, not dropped
    expect(existsSync(path.join(stateDir, "done", "r.json"))).toBe(false);
    // Sink comes online; flush.
    const { sink, seen } = fakeSink();
    sinkRef = sink;
    await relay.flushPending();
    expect(seen.has("golem-settle-r")).toBe(true);
    expect(readdirSync(pendingDir).length).toBe(0);
    expect(existsSync(path.join(stateDir, "done", "r.json"))).toBe(true);
    await relay.stop();
  });

  test("restart persistence + dedup: replay does not double-enqueue after tombstone", async () => {
    const stateDir = newDir();
    const registry = createCapabilityRegistry();
    const { sink, seen } = fakeSink();
    registry.register(WORKLIST_SINK, WORKLIST_SINK_VERSION, sink);
    const resolveSink = () => registry.resolve<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION);

    const c1 = fakeClient();
    c1.jobs.set("d", settled("d", "done", "once"));
    const r1 = new SettlementRelay({ client: c1.client, stateDir, resolveSink, backoffMs: 1 });
    await r1.recordDispatch("d");
    await r1.start();
    c1.push({ seq: 1, job_id: "d", state: "done" });
    await tick(80);
    await r1.stop();
    expect(seen.size).toBe(1);
    expect(existsSync(path.join(stateDir, "done", "d.json"))).toBe(true);

    // Fresh process (new relay, same durable dir): replays the same event.
    const c2 = fakeClient();
    c2.jobs.set("d", settled("d", "done", "once"));
    const r2 = new SettlementRelay({ client: c2.client, stateDir, resolveSink, backoffMs: 1 });
    await r2.start(); // startup reconcile sees the tombstone
    c2.push({ seq: 1, job_id: "d", state: "done" });
    await tick(80);
    await r2.stop();
    expect(seen.size).toBe(1); // still exactly once
    expect(c2.statusCalls).not.toContain("d"); // tombstone short-circuits before status
  });

  test("stop is clean and idempotent; no work after stop", async () => {
    const { client, jobs, push } = fakeClient();
    const { sink, seen } = fakeSink();
    jobs.set("s", settled("s"));
    const relay = new SettlementRelay({ client, stateDir: newDir(), resolveSink: () => sink, backoffMs: 1 });
    await relay.start();
    await relay.stop();
    await relay.stop(); // idempotent
    push({ seq: 1, job_id: "s", state: "done" });
    await tick(40);
    expect(seen.size).toBe(0);
  });

  test("crash between pending write and flush: startup flushes the retained envelope", async () => {
    const stateDir = newDir();
    // Simulate a pre-existing pending envelope + owned marker (crash before flush).
    const owned = path.join(stateDir, "owned"); const pending = path.join(stateDir, "pending");
    mkdirSync(owned, { recursive: true });
    mkdirSync(pending, { recursive: true });
    writeFileSync(path.join(owned, "c.json"), JSON.stringify({ id: "c" }));
    writeFileSync(path.join(pending, "c.json"), JSON.stringify(buildEnvelope("c", settled("c", "done", "recovered"))));
    const { client } = fakeClient();
    const { sink, seen } = fakeSink();
    const relay = new SettlementRelay({ client, stateDir, resolveSink: () => sink, backoffMs: 1 });
    await relay.start();
    await tick(40);
    await relay.stop();
    expect(seen.has("golem-settle-c")).toBe(true);
    expect(existsSync(path.join(stateDir, "done", "c.json"))).toBe(true);
  });

  test("healthy-but-silent SSE: periodic maintenance settles an owned job with NO terminal event", async () => {
    // Stream stays open forever (never returns) and emits no terminal event for
    // our job — modelling an endpoint/DB swap whose sequence is below our cursor.
    // Only the periodic maintenance backstop can settle it.
    const { client, jobs } = fakeClient({ keepStreamOpen: true });
    const { sink, seen } = fakeSink();
    jobs.set("silent", { id: "silent", state: "running" });
    const relay = new SettlementRelay({ client, stateDir: newDir(), resolveSink: () => sink, backoffMs: 1, tickMs: 30 });
    await relay.recordDispatch("silent"); // still running at dispatch → nothing yet
    expect(seen.size).toBe(0);
    await relay.start();
    await tick(50); // no terminal event ever arrives; job settles out-of-band
    jobs.set("silent", settled("silent", "done", "settled without an event"));
    // Wait for at least one maintenance tick to fire (tickMs=30).
    await tick(90);
    await relay.stop();
    expect(seen.has("golem-settle-silent")).toBe(true);
  });

  test("concurrent triggers are serialized: one pending envelope, single sink submission", async () => {
    // A slow sink lets multiple triggers pile up. If they raced, enqueue() would
    // be entered more than once concurrently for the same id; the opChain must
    // serialize them so at most one call is in flight at a time.
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const sink: DurableSink = {
      async enqueue(env: DurableEnqueueEnvelope): Promise<DurableAcceptance> {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return { accepted: true, id: env.id };
      },
      async withdraw() { return true; },
    };
    const { client, jobs } = fakeClient({ keepStreamOpen: true });
    jobs.set("race", settled("race", "done", "contended"));
    const relay = new SettlementRelay({ client, stateDir: newDir(), resolveSink: () => sink, backoffMs: 1, tickMs: 10 });
    // Fire many triggers at once: recordDispatch + start (startup) + rapid ticks
    // via the running timer all target the same pending envelope.
    const p = relay.recordDispatch("race");
    await relay.start();
    await p;
    await tick(120); // let the timer fire repeatedly while the slow sink drains
    await relay.stop();
    expect(maxInFlight).toBe(1); // never two concurrent sink calls for one id
    // Tombstone written after the first acceptance → no further submissions.
    expect(calls).toBe(1);
  });
});
