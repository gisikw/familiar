import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "./ledger.mjs";
import { Owner, installOwner, singleton } from "./owner.mjs";
import { LIMITS, settlement, prompt } from "./contract.mjs";

const machine = {
  name: "test",
  session: "test",
  models: ["test/model"],
  profile: "/worker/profile",
  host_key: "host",
  port: 2222,
  ssh_user: "worker",
};
const req = {
  key: "key",
  machine_id: "test",
  harness: "pi",
  model: "test/model",
  repo: "/repo",
  requested_ref: "HEAD",
  task: "Implement, test and review",
  label: "test",
};
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "familiar-agents-test-"));
  let now = 1000;
  const db = new Ledger(join(dir, "ledger.sqlite"), () => now),
    fence = db.acquire("first");
  const job = db.admit(fence, req, machine, "foreground");
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, fence, job, dir, time: (v) => (now = v) };
}
const report = (j) =>
  JSON.stringify({
    version: 1,
    job_id: j.job_id,
    nonce: j.settlement_nonce,
    verdict: "done",
    summary: "tested and reviewed",
    completed_at: "2026-09-09T00:00:00Z",
  });
class Fake {
  constructor(j) {
    this.online = true;
    this.status = "idle";
    this.raw = null;
    this.calls = [];
    this.job = j;
  }
  enrolled() {
    return machine;
  }
  async identity() {
    return this.online;
  }
  async plan(j) {
    return this.provision(j);
  }
  async provision(j) {
    return {
      remote_worktree: `/remote/${j.job_id}/worktree`,
      settlement_path: `/remote/${j.job_id}/settlement.json`,
      remote_profile: machine.profile,
      resolved_head: "a".repeat(40),
    };
  }
  async readSettlement() {
    return this.raw === null ? { missing: true } : { raw: this.raw };
  }
  agent() {
    return {
      name: this.job.herdr_agent_name,
      agent: "pi",
      terminal_id: "terminal",
      cwd: `/remote/${this.job.job_id}/worktree`,
      pane_id: "pane",
      workspace_id: "workspace",
      agent_status: this.status,
      interactive_ready: true,
      state_change_seq: this.seq ?? 1,
    };
  }
  async rpc(_j, method, params) {
    this.calls.push({ method, params });
    if (method === "workspace.list") return { workspaces: [] };
    if (method === "workspace.create")
      return { workspace: { workspace_id: "workspace" } };
    if (method === "pane.list") return { panes: [{ pane_id: "pane" }] };
    if (method === "agent.list")
      return { agents: this.started ? [this.agent()] : [] };
    if (method === "agent.start") {
      this.started = true;
      return { agent: this.agent() };
    }
    if (method === "agent.get") return { agent: this.agent() };
    if (method === "agent.prompt") this.status = "working";
    return {};
  }
}
function running(t) {
  const f = setup(t),
    transport = new Fake(f.job),
    notes = new Map();
  const o = new Owner(
    f.db,
    transport,
    async (n) => {
      notes.set(n.id, n);
      return true;
    },
    { idleGraceMs: 0 },
  );
  o.fence = f.fence;
  return { ...f, o, transport, notes };
}
test("admission uniqueness, parameter conflict, transactional active bounds", (t) => {
  const f = setup(t);
  assert.equal(f.db.admit(f.fence, req, machine, "other").job_id, f.job.job_id);
  assert.throws(
    () => f.db.admit(f.fence, { ...req, task: "different" }, machine, "other"),
    /key reused/,
  );
  for (let i = 1; i < LIMITS.perMachine; i++)
    f.db.admit(f.fence, { ...req, key: `k${i}` }, machine, "foreground");
  assert.throws(
    () =>
      f.db.admit(f.fence, { ...req, key: "overflow" }, machine, "foreground"),
    /limit/,
  );
});
test("crash takeover fences every old write and renewal, preserves admission/nonce", (t) => {
  const f = setup(t);
  assert.equal(f.db.acquire("second"), null);
  f.time(LIMITS.leaseMs + 1001);
  const next = f.db.acquire("second");
  assert.ok(next);
  assert.throws(() => f.db.update(f.fence, f.job, {}), /lease lost/);
  assert.throws(() => f.db.renew(f.fence), /lease lost/);
  f.db.release(f.fence);
  f.db.check(next);
  const reopened = new Ledger(
    join(f.dir, "ledger.sqlite"),
    () => LIMITS.leaseMs + 1001,
  );
  t.after(() => reopened.close());
  assert.equal(
    reopened.get(f.job.job_id).settlement_nonce,
    f.job.settlement_nonce,
  );
});
test("CAS refuses stale network snapshots after human abandon", (t) => {
  const f = setup(t);
  f.db.update(f.fence, f.job, {
    semantic_state: "abandoned",
    operator: { actor: "human" },
  });
  assert.throws(
    () => f.db.update(f.fence, f.job, { semantic_state: "running" }),
    /stale/,
  );
});
test("settlement validation rejects malformed, partial, oversized, wrong nonce and extra fields", (t) => {
  const { job } = setup(t);
  assert.equal(JSON.parse(settlement(report(job), job)).verdict, "done");
  for (const raw of [
    "{",
    "null",
    "[]",
    " ".repeat(LIMITS.settlement + 1),
    report({ ...job, settlement_nonce: "wrong" }),
    JSON.stringify({ ...JSON.parse(report(job)), extra: "unbounded" }),
    JSON.stringify({
      ...JSON.parse(report(job)),
      usage: { input_tokens: -1, output_tokens: 0, cost_micros: 0 },
    }),
  ])
    assert.throws(() => settlement(raw, job));
  assert.match(
    prompt({ ...job, settlement_path: "/exact" }, "do work"),
    /atomically rename/,
  );
});
test("real foreground argv, idle is unresolved, manual resume then first settlement wins", async (t) => {
  const f = running(t);
  await f.o.observe(f.job);
  const start = f.transport.calls.find((c) => c.method === "agent.start");
  assert.equal(start.params.kind, "pi");
  assert.deepEqual(start.params.args.slice(0, 4), [
    "--provider",
    "test",
    "--model",
    "model",
  ]);
  assert.equal(start.params.args[4], "--extension");
  assert.match(start.params.args[5], /\/model-guard\.ts$/);
  assert.match(
    f.transport.calls.find((c) => c.method === "agent.prompt").params.text,
    /Settlement nonce:/,
  );
  let j = f.db.get(f.job.job_id);
  assert.equal(j.semantic_state, "running");
  f.transport.status = "done";
  await f.o.observe(j);
  j = f.db.get(j.job_id);
  assert.equal(j.semantic_state, "idle_unsettled");
  assert.ok(j.first_idle_observed_at);
  f.transport.status = "working";
  await f.o.observe(j);
  j = f.db.get(j.job_id);
  assert.equal(j.first_idle_observed_at, null);
  assert.equal(j.semantic_state, "running");
  f.transport.raw = report(j);
  await f.o.observe(j);
  j = f.db.get(j.job_id);
  assert.equal(j.semantic_state, "running");
  f.transport.status = "idle";
  await f.o.observe(j);
  j = f.db.get(j.job_id);
  assert.equal(j.semantic_state, "settled");
  assert.throws(
    () => f.db.update(f.fence, j, { settlement_json: "replacement" }),
    /terminal/,
  );
  await f.o.reconcile();
  await f.o.reconcile();
  assert.equal(
    [...f.notes.values()].filter((n) => n.id.endsWith("-settled")).length,
    1,
  );
});
test("offline retains pending cancel, reconnect interrupts but does not settle", async (t) => {
  const f = running(t);
  await f.o.observe(f.job);
  f.o.kick = () => {};
  f.o.intent(f.job.job_id, "cancel", "", "cancel-key", "human");
  f.transport.online = false;
  await f.o.observe(f.db.get(f.job.job_id));
  let j = f.db.get(f.job.job_id);
  assert.equal(j.semantic_state, "cancel_requested");
  assert.equal(j.reachability, "unknown");
  assert.equal(j.intents[0].state, "pending");
  f.transport.online = true;
  f.transport.status = "idle";
  await f.o.observe(j);
  j = f.db.get(j.job_id);
  assert.equal(j.semantic_state, "cancel_requested");
  assert.equal(j.intents[0].state, "delivered");
  assert.equal(
    f.transport.calls.filter((c) => c.method === "agent.send_keys").length,
    1,
  );
});
test("blocked answer uses existing structured pane input; uncertain delivery never auto-repeats", async (t) => {
  const f = running(t);
  await f.o.observe(f.job);
  f.o.kick = () => {};
  f.transport.status = "blocked";
  await f.o.observe(f.db.get(f.job.job_id));
  f.o.intent(f.job.job_id, "answer", "yes", "answer-key", "human");
  const rpc = f.transport.rpc.bind(f.transport);
  f.transport.rpc = async (...args) => {
    if (args[1] === "pane.send_input") {
      await rpc(...args);
      throw new Error("lost response");
    }
    return rpc(...args);
  };
  await assert.rejects(f.o.observe(f.db.get(f.job.job_id)));
  await f.o.observe(f.db.get(f.job.job_id));
  assert.equal(
    f.transport.calls.filter((c) => c.method === "pane.send_input").length,
    1,
  );
  assert.equal(f.db.get(f.job.job_id).intents[0].state, "delivery_unknown");
});
test("lost workspace response reconciles by identity, never duplicates creation", async (t) => {
  const f = running(t),
    rpc = f.transport.rpc.bind(f.transport);
  let created = false;
  f.transport.rpc = async (...args) => {
    if (args[1] === "workspace.create") {
      created = true;
      throw new Error("lost");
    }
    if (args[1] === "workspace.list" && created)
      return {
        workspaces: [{ label: f.job.label, workspace_id: "workspace" }],
      };
    return rpc(...args);
  };
  await assert.rejects(f.o.observe(f.job));
  await f.o.observe(f.db.get(f.job.job_id));
  assert.equal(f.db.get(f.job.job_id).phase, "observe");
});
test("definitive read-only remote admission failure is loud; route failure stays unresolved", async (t) => {
  const f = running(t);
  f.transport.plan = async () => {
    throw new Error("route lost");
  };
  await f.o.reconcile();
  let j = f.db.get(f.job.job_id);
  assert.equal(j.semantic_state, "provisioning");
  assert.equal(j.reachability, "unknown");
  f.transport.plan = async () => ({
    admission_error: "remote_preflight_failed",
  });
  await f.o.reconcile();
  j = f.db.get(j.job_id);
  assert.equal(j.semantic_state, "failed_admission");
  assert.match(j.last_error, /read-only admission/);
  assert.equal(f.transport.calls.length, 0);
  assert.equal(
    [...f.notes.values()].filter((n) => n.id.endsWith("failed-admission"))
      .length,
    1,
  );
});

test("route loss then reconnect accepts settlement exactly once", async (t) => {
  const f = running(t);
  await f.o.observe(f.job);
  f.transport.online = false;
  await f.o.reconcile();
  let j = f.db.get(f.job.job_id);
  assert.equal(j.semantic_state, "running");
  assert.equal(j.reachability, "unknown");
  f.transport.raw = report(j);
  f.transport.status = "idle";
  f.transport.online = true;
  await f.o.reconcile();
  await f.o.reconcile();
  assert.equal(f.db.get(j.job_id).semantic_state, "settled");
  assert.equal(
    [...f.notes.values()].filter((n) => n.id.endsWith("settled")).length,
    1,
  );
});

test("generation loss during network call cannot launch or update", async (t) => {
  const f = running(t);
  f.transport.identity = async () => {
    f.time(LIMITS.leaseMs + 1001);
    f.db.acquire("new");
    return true;
  };
  await assert.rejects(f.o.observe(f.job), /lease lost/);
  assert.equal(f.transport.calls.length, 0);
  assert.equal(f.db.get(f.job.job_id).semantic_state, "requested");
});
test("process-global singleton rejects loader/session duplicates, stale disposer safe", () => {
  const a = {},
    b = {};
  const remove = installOwner(a);
  assert.equal(singleton(), a);
  assert.throws(() => installOwner(b), /already/);
  remove();
  const removeB = installOwner(b);
  remove();
  assert.equal(singleton(), b);
  removeB();
});
test("self-scheduling pass never overlaps; foreground timer remains responsive", async (t) => {
  const f = running(t);
  let release,
    passes = 0,
    max = 0,
    active = 0;
  f.o.reconcile = async () => {
    passes++;
    active++;
    max = Math.max(max, active);
    await new Promise((r) => (release = r));
    active--;
  };
  f.o.kick();
  f.o.kick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(passes, 1);
  assert.equal(max, 1);
  f.o.abort.abort();
  release();
  await f.o.pass;
  assert.equal(active, 0);
});
test("cancel before provisioning never starts or prompts new work", async (t) => {
  const f = running(t);
  f.o.kick = () => {};
  f.o.intent(f.job.job_id, "cancel", "", "c", "human");
  await f.o.observe(f.db.get(f.job.job_id));
  assert.equal(f.transport.calls.length, 0);
  assert.equal(f.db.get(f.job.job_id).semantic_state, "cancel_requested");
});
test("cancel delivery is independent of a broken settlement-file route", async (t) => {
  const f = running(t);
  await f.o.observe(f.job);
  f.o.kick = () => {};
  f.transport.readSettlement = async () => {
    throw new Error("native route lost");
  };
  f.o.intent(f.job.job_id, "cancel", "", "c", "human");
  await f.o.observe(f.db.get(f.job.job_id));
  assert.equal(
    f.transport.calls.filter((c) => c.method === "agent.send_keys").length,
    1,
  );
});
test("a native human answer invalidates the queued answer; second blocker gets its own notification", async (t) => {
  const f = running(t);
  await f.o.observe(f.job);
  f.o.kick = () => {};
  f.transport.status = "blocked";
  f.transport.seq = 2;
  await f.o.observe(f.db.get(f.job.job_id));
  f.o.intent(f.job.job_id, "answer", "yes", "a", "exo");
  f.transport.status = "working";
  f.transport.seq = 3;
  await f.o.observe(f.db.get(f.job.job_id));
  assert.equal(
    f.transport.calls.filter((c) => c.method === "pane.send_input").length,
    0,
  );
  f.o.resolveIntent(f.job.job_id, "a", "human already answered", "human");
  await f.o.observe(f.db.get(f.job.job_id));
  f.transport.status = "blocked";
  f.transport.seq = 4;
  await f.o.observe(f.db.get(f.job.job_id));
  const ids = f.db.pending(f.fence).map((n) => n.id);
  assert.equal(ids.filter((id) => id.includes("-blocked-")).length, 2);
});
test("prompt uncertainty is visible and explicitly recoverable, never blindly replayed", async (t) => {
  const f = running(t);
  await f.o.observe(f.job);
  f.o.kick = () => {};
  let j = f.db.get(f.job.job_id);
  j = f.db.update(f.fence, j, { task: req.task, prompt_delivery: "unknown" });
  f.transport.status = "idle";
  await f.o.observe(j);
  const before = f.transport.calls.filter(
    (c) => c.method === "agent.prompt",
  ).length;
  f.o.resolveOperation(
    j.job_id,
    "prompt",
    "retry-confirmed-absent",
    "native inspection proves original task absent",
    "human",
  );
  await f.o.observe(f.db.get(j.job_id));
  assert.equal(
    f.transport.calls.filter((c) => c.method === "agent.prompt").length,
    before + 1,
  );
  assert.equal(f.db.get(j.job_id).prompt_delivery, "delivered");
});
test("successful slow calls renew between operations, not just between jobs", async (t) => {
  const f = running(t);
  let count = 0;
  const rpc = f.transport.rpc.bind(f.transport);
  f.transport.rpc = async (...args) => {
    const r = await rpc(...args);
    f.time(1000 + ++count * 19000);
    return r;
  };
  await f.o.observe(f.job);
  assert.ok(count >= 7);
  assert.equal(f.db.get(f.job.job_id).semantic_state, "running");
});
test("admission hashing ignores JSON property order", (t) => {
  const f = setup(t);
  const reversed = Object.fromEntries(Object.entries(req).reverse());
  assert.equal(
    f.db.admit(f.fence, reversed, machine, "foreground").job_id,
    f.job.job_id,
  );
});
test("remote provisioning cannot inject local semantic state or correlation fields", async (t) => {
  const f = running(t),
    provision = f.transport.provision.bind(f.transport);
  f.transport.provision = async (j) => ({
    ...(await provision(j)),
    semantic_state: "settled",
    settlement_nonce: "injected",
  });
  await assert.rejects(f.o.observe(f.job), /provision result/);
  const j = f.db.get(f.job.job_id);
  assert.equal(j.semantic_state, "provisioning");
  assert.equal(j.settlement_nonce, f.job.settlement_nonce);
  assert.equal(f.transport.calls.length, 0);
});
test("oversized Herdr session metadata is never stored", async (t) => {
  const f = running(t);
  await f.o.observe(f.job);
  const agent = f.transport.agent.bind(f.transport);
  f.transport.agent = () => ({
    ...agent(),
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "path",
      value: "x".repeat(4097),
    },
  });
  await assert.rejects(f.o.observe(f.db.get(f.job.job_id)), /invalid/);
  assert.equal(f.db.get(f.job.job_id).agent_session, null);
});
test("gone is unresolved without a report; a valid report plus confirmed no active agent settles", async (t) => {
  const f = running(t);
  await f.o.observe(f.job);
  f.transport.started = false;
  await f.o.observe(f.db.get(f.job.job_id));
  let j = f.db.get(f.job.job_id);
  assert.equal(j.semantic_state, "idle_unsettled");
  assert.equal(j.observation, "gone");
  assert.equal(j.settlement_json, null);
  f.transport.raw = report(j);
  await f.o.observe(j);
  j = f.db.get(j.job_id);
  assert.equal(j.semantic_state, "settled");
  assert.equal(j.observation, "gone");
});
test("uncertain intent fences automatic settlement until explicit resolution", async (t) => {
  const f = running(t);
  await f.o.observe(f.job);
  f.o.kick = () => {};
  f.o.intent(f.job.job_id, "steer", "review again", "s", "exo");
  let j = f.db.get(f.job.job_id);
  j = f.db.update(f.fence, j, {
    intents: j.intents.map((i) => ({ ...i, state: "delivery_unknown" })),
  });
  f.transport.status = "idle";
  f.transport.raw = report(j);
  await f.o.observe(j);
  assert.equal(f.db.get(j.job_id).semantic_state, "idle_unsettled");
  f.o.resolveIntent(
    j.job_id,
    "s",
    "native inspection resolved the uncertainty",
    "human",
  );
  await f.o.observe(f.db.get(j.job_id));
  assert.equal(f.db.get(j.job_id).semantic_state, "settled");
});
test("shutdown is idempotent", async (t) => {
  const f = running(t);
  const first = f.o.stop();
  assert.equal(f.o.stop(), first);
  await first;
});
test("future schema versions fail closed before new migrations", (t) => {
  const f = setup(t);
  f.db.db.exec("UPDATE schema_version SET version=99");
  assert.throws(
    () => new Ledger(join(f.dir, "ledger.sqlite")),
    /unsupported agents ledger version/,
  );
  assert.equal(f.db.get(f.job.job_id).settlement_nonce, f.job.settlement_nonce);
});
test("retention drops report details, not admission dedup or operator attribution", (t) => {
  const f = setup(t);
  let j = f.db.update(f.fence, f.job, {
    semantic_state: "settled",
    settlement_json: report(f.job),
    settlement_verdict: "done",
    operator: { actor: "operator", at: 1000, reason: "details" },
  });
  j = f.db.update(f.fence, j, { cleanup_state: "complete" }, undefined, true);
  f.time(1000 + 91 * 86400000);
  const fence = f.db.acquire("gc");
  assert.equal(f.db.gc(fence), 1);
  const kept = f.db.get(j.job_id);
  assert.equal(kept.settlement_json, null);
  assert.equal(kept.settlement_verdict, "done");
  assert.equal(kept.operator.actor, "operator");
  assert.equal(kept.retained_tombstone, true);
  assert.equal(f.db.admit(fence, req, machine, "later").job_id, j.job_id);
});
for (const phase of [
  "workspace",
  "workspace_attempted",
  "launch",
  "launch_attempted",
  "prompt",
])
  test(`cancel at ${phase} never submits a new task`, async (t) => {
    const f = running(t);
    f.o.kick = () => {};
    f.transport.started = ["launch_attempted", "prompt"].includes(phase);
    f.db.update(f.fence, f.job, {
      phase,
      semantic_state: "provisioning",
      herdr_workspace_id: "workspace",
      herdr_pane_id: "pane",
      herdr_agent_id: phase === "prompt" ? "terminal" : null,
      settlement_path: `/remote/${f.job.job_id}/settlement.json`,
    });
    f.o.intent(f.job.job_id, "cancel", "", "c", "human");
    await f.o.observe(f.db.get(f.job.job_id));
    assert.equal(
      f.transport.calls.filter((c) =>
        ["agent.start", "agent.prompt", "workspace.create"].includes(c.method),
      ).length,
      0,
    );
    assert.equal(f.db.get(f.job.job_id).semantic_state, "cancel_requested");
  });
