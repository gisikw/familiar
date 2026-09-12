// Regression proofs for the live launch failure's Familiar-side behaviour.
//
// Herdr 0.9 `agent.start --kind pi` types the canonical executable into the
// dedicated pane's interactive shell (`AgentStartParams` carries no env), and
// that shell's startup files own PATH by then. Making the canonical runtime
// available there is the Drover NODE's job, through its own trusted shell
// initialisation; Familiar sends semantic inputs only and never probes, injects,
// selects or attests a pane environment.
//
// What Familiar must get right is the observation: `agent.start` returns a
// launch-pending PLACEHOLDER (requested name, `launch_pending: true`,
// `agent_status: "unknown"`, no `agent` kind) which Herdr never reaps when the
// startup failed, and whose name stays taken until the workspace is closed.
// Those facts were captured from a real pinned Herdr 0.9 server; see
// test/agents/launch-proof.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "./ledger.mjs";
import { Owner } from "./owner.mjs";
import { launchPendingPlaceholder } from "./contract.mjs";

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

class Herdr {
  constructor(job) {
    this.job = job;
    this.online = true;
    this.calls = [];
    this.workspaces = [];
    this.panes = [{ pane_id: "pane" }];
    this.agents = [];
    this.foreground = [];
    this.startupFails = false;
    this.status = "idle";
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
    return { missing: true };
  }
  async native() {
    this.calls.push({ method: "native.cleanup" });
    return { complete: true };
  }
  async rpc(job, method, params) {
    this.calls.push({ method, params });
    if (method === "workspace.list") return { workspaces: this.workspaces };
    if (method === "workspace.create") {
      this.createdEnv = params.env;
      this.workspaces.push({ workspace_id: "workspace", label: params.label });
      return { workspace: { workspace_id: "workspace" } };
    }
    if (method === "workspace.close") {
      this.workspaces = this.workspaces.filter(
        (w) => w.workspace_id !== params.workspace_id,
      );
      this.agents = []; // closing the workspace finally releases the name
      return {};
    }
    if (method === "pane.list") return { panes: this.panes };
    if (method === "pane.process_info")
      return {
        process_info: {
          pane_id: params.pane_id,
          shell_pid: 10,
          // Herdr lists the idle shell itself as its own foreground group.
          foreground_process_group_id: this.foreground.length ? 11 : 10,
          foreground_processes: this.foreground,
        },
      };
    if (method === "agent.start") {
      if (this.agents.some((a) => a.name === params.name))
        throw new Error("Herdr operation rejected; inspect native workspace");
      this.startArgs = params.args;
      const placeholder = {
        terminal_id: "pending-terminal",
        name: params.name,
        workspace_id: "workspace",
        pane_id: params.pane_id,
        agent_status: "unknown",
        launch_pending: true,
        state_change_seq: 0,
        cwd: job.remote_worktree,
      };
      this.agents.push(placeholder);
      if (!this.startupFails) {
        this.launched = placeholder;
        this.foreground = [
          { pid: 11, name: "pi", argv: ["pi"], cwd: job.remote_worktree },
        ];
      }
      return { agent: placeholder };
    }
    if (method === "agent.list") return { agents: this.agents };
    if (method === "agent.get")
      return {
        agent: this.agents.find(
          (a) => a.pane_id === (params.target ?? params.pane_id),
        ),
      };
    if (method === "agent.prompt") return {};
    return {};
  }
  /** Herdr promotes the placeholder only once the real harness is interactive. */
  becomeInteractive() {
    const a = this.launched;
    assert.ok(a, "no harness process was ever started");
    Object.assign(a, {
      terminal_id: "terminal",
      agent: "pi",
      agent_status: this.status,
      launch_pending: false,
      interactive_ready: true,
      state_change_seq: 1,
    });
  }
}
function running(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "familiar-agents-launch-"));
  let now = 1000;
  const db = new Ledger(join(dir, "ledger.sqlite"), () => now);
  const fence = db.acquire("owner");
  const job = db.admit(fence, req, machine, "foreground");
  const transport = new Herdr(job);
  const o = new Owner(db, transport, async () => true, {
    idleGraceMs: 0,
    ...options,
  });
  o.fence = fence;
  o.kick = () => {};
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    db,
    fence,
    job,
    o,
    transport,
    time: (v) => (now = v),
    get: () => db.get(job.job_id),
    observe: () => o.observe(db.get(job.job_id)),
  };
}
const counts = (f, method) =>
  f.transport.calls.filter((c) => c.method === method).length;
const notified = (f, suffix) =>
  f.db.pending(f.fence).filter((n) => n.id.endsWith(suffix)).length;

test("a launch-pending placeholder is a truthful pending state, never an interactive agent", async (t) => {
  const f = running(t);
  await f.observe();
  const j = f.get();
  assert.ok(
    launchPendingPlaceholder({ launch_pending: true, agent_status: "unknown" }),
  );
  assert.equal(
    launchPendingPlaceholder({ launch_pending: false, agent: "pi" }),
    false,
  );
  // The placeholder is not an identity mismatch and not a launched agent.
  assert.equal(j.phase, "launch_attempted");
  assert.equal(j.observation, "launch_pending");
  assert.equal(j.herdr_agent_id, null);
  assert.equal(j.herdr_pending_terminal_id, "pending-terminal");
  assert.equal(j.last_error, null);
  assert.equal(j.semantic_state, "provisioning");
  // Nothing is prompted while pending, and no pass launches again.
  assert.equal(counts(f, "agent.prompt"), 0);
  await f.observe();
  await f.observe();
  assert.equal(counts(f, "agent.start"), 1);
  // Familiar supplies semantic inputs only: no PATH, runtime or shell change.
  assert.deepEqual(Object.keys(f.transport.createdEnv).sort(), [
    "FAMILIAR_AGENT_EXPECTED_MODEL",
    "PI_CODING_AGENT_DIR",
  ]);
  assert.equal(counts(f, "pane.send_input"), 0);
  // The launch itself stays exactly pinned.
  assert.deepEqual(f.transport.startArgs, [
    "--provider",
    "test",
    "--model",
    "model",
    "--extension",
    `/remote/${f.job.job_id}/model-guard.ts`,
  ]);
  // Once Herdr reports the real interactive agent, the job proceeds normally.
  f.transport.becomeInteractive();
  await f.observe();
  const next = f.get();
  assert.equal(next.phase, "observe");
  assert.equal(next.prompt_delivery, "delivered");
  assert.equal(next.herdr_agent_id, "terminal");
  assert.equal(next.herdr_pending_terminal_id, null);
  assert.equal(counts(f, "agent.start"), 1);
});

test("a startup that never becomes an agent is surfaced once, with no blind relaunch", async (t) => {
  const f = running(t, { launchGraceMs: 50 });
  // The node could not execute the harness (`bash: pi: command not found`): the
  // pane returns to its own shell while Herdr keeps the placeholder forever.
  f.transport.startupFails = true;
  await f.observe();
  assert.equal(f.get().phase, "launch_attempted");
  // Inside the grace it is only pending: nothing is declared.
  await f.observe();
  assert.equal(f.get().observation, "launch_pending");
  await new Promise((r) => setTimeout(r, 60));
  // A genuine foreground process keeps it pending rather than failing it.
  f.transport.foreground = [{ pid: 11, name: "pi", cwd: "/x" }];
  await f.observe();
  assert.equal(f.get().phase, "launch_attempted");
  // Proven-empty pane foreground after the grace declares the startup failure.
  f.transport.foreground = [];
  await f.observe();
  const j = f.get();
  assert.equal(j.phase, "launch_failed");
  assert.equal(j.observation, "launch_failed");
  assert.match(j.last_error, /Agent startup failed/);
  assert.match(j.last_error, /never relaunched/);
  assert.equal(counts(f, "agent.start"), 1);
  assert.equal(notified(f, "launch-failed"), 1);
  // Further passes neither relaunch nor renotify, and never invent an outcome.
  await f.observe();
  await f.observe();
  assert.equal(counts(f, "agent.start"), 1);
  assert.equal(f.get().semantic_state, "provisioning");
  assert.equal(f.get().settlement_json, null);
  // A failed startup is not an uncertain operation an operator may retry blindly:
  // the Herdr name stays taken, so only cleanup/fresh dispatch can recover.
  assert.throws(
    () =>
      f.o.resolveOperation(
        f.job.job_id,
        "launch",
        "retry-confirmed-absent",
        "inspected",
        "human",
      ),
    /no matching uncertain operation/,
  );
});

test("operator recovery abandons the job and cleanup closes the unreapable placeholder", async (t) => {
  const f = running(t, { launchGraceMs: 0 });
  f.transport.startupFails = true;
  await f.observe();
  await f.observe();
  assert.equal(f.get().phase, "launch_failed");
  assert.equal(
    f.o.abandon(f.job.job_id, "startup failed; dispatching fresh", "human")
      .semantic_state,
    "abandoned",
  );
  f.db.update(
    f.fence,
    f.db.get(f.job.job_id),
    { cleanup_state: "requested" },
    undefined,
    true,
  );
  await f.o.cleanup(f.db.get(f.job.job_id));
  const j = f.db.get(f.job.job_id);
  assert.equal(j.cleanup_state, "complete", j.cleanup_error ?? "");
  assert.ok(f.transport.calls.some((c) => c.method === "workspace.close"));
  assert.ok(f.transport.calls.some((c) => c.method === "native.cleanup"));
  assert.deepEqual(f.transport.agents, []);
});

test("cleanup still refuses a live agent in the workspace", async (t) => {
  const f = running(t);
  await f.observe();
  f.transport.becomeInteractive();
  await f.observe();
  f.db.update(f.fence, f.db.get(f.job.job_id), { semantic_state: "abandoned" });
  f.db.update(
    f.fence,
    f.db.get(f.job.job_id),
    { cleanup_state: "requested" },
    undefined,
    true,
  );
  await f.o.cleanup(f.db.get(f.job.job_id));
  assert.equal(f.db.get(f.job.job_id).cleanup_state, "needs_attention");
  assert.ok(!f.transport.calls.some((c) => c.method === "workspace.close"));
});
