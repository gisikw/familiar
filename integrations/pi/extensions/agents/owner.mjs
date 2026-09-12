import { randomUUID } from "node:crypto";
import {
  LIMITS,
  terminal,
  prompt,
  settlement,
  projection,
  text,
  digest,
  provisionedPaths,
  agentObservation,
  modelSelection,
  modelGuardPath,
  launchPendingPlaceholder,
} from "./contract.mjs";

const SLOT = Symbol.for("familiar.agents.owner.v1");

// Herdr 0.9 obtains `name` from the native process comm, while Darwin obtains
// `argv0` independently from KERN_PROCARGS2. Node-launched Pi therefore appears
// as { name: "node", argv0: "pi" } on Darwin. Only admit that representation
// after the surrounding cleanup correlation and every process fact are exact.
function isManagedForegroundProcess(
  job,
  workspace,
  pane,
  processInfo,
  agent,
  process,
) {
  const expected = [
    job.herdr_workspace_id,
    job.herdr_pane_id,
    job.herdr_agent_id,
    job.remote_worktree,
  ];
  if (expected.some((value) => typeof value !== "string" || !value))
    return false;
  if (!job.agent_session || typeof job.agent_session !== "object")
    return false;
  if (
    workspace.workspace_id !== job.herdr_workspace_id ||
    workspace.label !== job.label ||
    pane.pane_id !== job.herdr_pane_id ||
    processInfo.pane_id !== job.herdr_pane_id ||
    agent?.workspace_id !== job.herdr_workspace_id ||
    agent.pane_id !== job.herdr_pane_id ||
    agent.terminal_id !== job.herdr_agent_id ||
    agent.name !== job.herdr_agent_name ||
    agent.agent !== job.harness ||
    !["idle", "done"].includes(agent.agent_status) ||
    agent.launch_pending === true ||
    JSON.stringify(agent.agent_session) !== JSON.stringify(job.agent_session) ||
    agent.cwd !== job.remote_worktree ||
    (agent.foreground_cwd !== undefined &&
      agent.foreground_cwd !== job.remote_worktree) ||
    !Number.isSafeInteger(process.pid) ||
    process.pid <= 0 ||
    process.pid === processInfo.shell_pid ||
    processInfo.foreground_process_group_id !== process.pid ||
    process.cwd !== job.remote_worktree
  )
    return false;
  return (
    process.name === job.harness ||
    (job.harness === "pi" && process.name === "node" && process.argv0 === "pi")
  );
}

export function singleton() {
  return process[SLOT];
}
export function installOwner(owner) {
  if (process[SLOT])
    throw new Error("Familiar Agents already has a process owner");
  process[SLOT] = owner;
  return () => {
    if (process[SLOT] === owner) delete process[SLOT];
  };
}
export class Owner {
  constructor(ledger, transport, notify, options = {}) {
    this.ledger = ledger;
    this.transport = transport;
    this.notify = notify;
    this.id = randomUUID();
    this.abort = new AbortController();
    this.timer = null;
    this.pass = null;
    this.idleGraceMs = options.idleGraceMs ?? LIMITS.idleGraceMs;
    // How long a truthful launch-pending placeholder may persist before the
    // startup is reported failed (never relaunched).
    this.launchGraceMs = options.launchGraceMs ?? LIMITS.launchGraceMs;
    // Per-route/per-node Agent availability. Absent store = fail closed.
    this.policy = options.policy ?? null;
    this.delay = 1000;
  }
  start() {
    try {
      this.uninstall = installOwner(this);
      this.fence = this.ledger.acquire(this.id);
    } catch (e) {
      this.uninstall?.();
      this.ledger.close();
      throw e;
    }
    // Another process can own the DB. Remain read-only and try takeover after expiry.
    this.kick();
  }
  guard() {
    this.abort.signal.throwIfAborted();
    this.ledger.check(this.fence);
  }
  save(job, changes, note) {
    this.guard();
    const next = this.ledger.update(this.fence, job, changes, note);
    this.changed?.();
    return next;
  }
  async call(fn) {
    this.guard();
    this.ledger.renew(this.fence);
    const signal = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(LIMITS.callMs),
    ]);
    let detach;
    const interrupted = new Promise((_, reject) => {
      const listener = () =>
        reject(new Error("agents call deadline or shutdown; outcome unknown"));
      signal.addEventListener("abort", listener, { once: true });
      detach = () => signal.removeEventListener("abort", listener);
    });
    try {
      const r = await Promise.race([
        Promise.resolve().then(() => fn(signal)),
        interrupted,
      ]);
      this.guard();
      return r;
    } finally {
      detach();
    }
  }
  note(job, kind, priority = 3) {
    return {
      id: `${job.job_id}-${kind}`,
      priority,
      type: "notify",
      source: `familiar-agents:${job.owner_session}`,
      summary: `${job.label}: ${kind}`,
      body: JSON.stringify(projection(job)),
    };
  }
  kick() {
    if (this.abort.signal.aborted) return;
    if (this.pass) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.pass = this.reconcile()
      .catch(() => {
        this.delay = Math.min(30000, this.delay * 2);
      })
      .finally(() => {
        this.pass = null;
        if (!this.abort.signal.aborted) {
          const delay = this.again
            ? 0
            : this.delay * (0.8 + Math.random() * 0.4);
          this.again = false;
          this.timer = setTimeout(() => this.kick(), delay);
          this.timer.unref?.();
        }
      });
  }
  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.abort.abort();
      clearTimeout(this.timer);
      await this.pass;
      if (this.fence) this.ledger.release(this.fence);
      this.uninstall?.();
      this.ledger.close();
    })();
    return this.stopping;
  }
  async reconcile() {
    if (!this.fence) this.fence = this.ledger.acquire(this.id);
    if (!this.fence) {
      this.delay = 5000;
      return;
    }
    try {
      this.ledger.renew(this.fence);
    } catch {
      this.fence = null;
      this.delay = 1000;
      return;
    }
    const jobs = this.ledger.active();
    let cursor = 0,
      errors = 0;
    const worker = async () => {
      while (cursor < jobs.length && !this.abort.signal.aborted) {
        const j = jobs[cursor++];
        try {
          this.ledger.renew(this.fence);
          if (terminal(j)) await this.cleanup(j);
          else await this.observe(j);
        } catch {
          errors++;
          // Re-read only for the reachability/error annotation; never overwrite a
          // concurrent tool's semantic change with the old network snapshot.
          try {
            const latest = this.ledger.get(j.job_id);
            if (!terminal(latest))
              this.save(latest, {
                reachability: "unknown",
                observation_gap:
                  (latest.observation_gap ?? 0) +
                  (latest.reachability === "unknown" ? 0 : 1),
                last_error:
                  "Observation unavailable or rejected; outcome unresolved",
              });
          } catch {}
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(LIMITS.concurrency, jobs.length) }, worker),
    );
    for (const n of this.ledger.pending(this.fence)) {
      this.guard();
      // Sink is durable + idempotent. Crash after acceptance before ack replays
      // the SAME id; notification payload is captured in the ledger transaction.
      if (await this.call(() => this.notify(n)))
        this.ledger.delivered(this.fence, n.id, n.withdraw);
    }
    this.ledger.gc(this.fence);
    this.delay = errors
      ? Math.min(30000, this.delay * 2)
      : jobs.length
        ? 3000
        : 15000;
  }
  async observe(job) {
    if (
      job.semantic_state === "cancel_requested" &&
      !["launch_attempted", "prompt", "observe"].includes(job.phase)
    ) {
      this.save(
        job,
        {
          observation: "not_started",
          last_error:
            "Cancellation withheld new launch/task. Explicit abandon or operator settlement is required.",
        },
        this.note(job, "cancel-unsettled"),
      );
      return;
    }
    if (!(await this.call((s) => this.transport.identity(job, s)))) {
      this.save(job, {
        reachability: "unknown",
        observation_gap:
          (job.observation_gap ?? 0) + (job.reachability === "unknown" ? 0 : 1),
        last_error: "Machine offline; semantic state retained",
      });
      return;
    }
    job = this.save(job, {
      reachability: "fresh",
      last_observed_at: Date.now(),
      last_error:
        job.prompt_delivery === "unknown"
          ? "Initial prompt delivery unknown; inspect natively and resolve the operation before retry"
          : null,
    });
    if (job.phase === "provision") {
      job = this.save(job, {
        semantic_state:
          job.semantic_state === "cancel_requested"
            ? "cancel_requested"
            : "provisioning",
      });
      if (!job.settlement_path) {
        const planned = await this.call((s) => this.transport.plan(job, s));
        if (
          planned?.admission_error === "remote_preflight_failed" &&
          Object.keys(planned).length === 1
        ) {
          const changes = {
            semantic_state: "failed_admission",
            last_error:
              "Remote read-only admission checks failed. Inspect repository/ref, enrolled worker profile and toolchain; dispatch with a new key after correction.",
            task: null,
          };
          this.save(
            job,
            changes,
            this.note({ ...job, ...changes }, "failed-admission", 2),
          );
          return;
        }
        const plan = provisionedPaths(planned, job);
        // Resolve/pin remote paths and commit BEFORE any provisioning mutation.
        // A lost apply reply cannot lose the cleanup address or follow a new XDG root.
        job = this.save(job, plan);
      }
      const paths = provisionedPaths(
        await this.call((s) => this.transport.provision(job, s)),
        job,
      );
      job = this.save(job, { ...paths, phase: "workspace" });
    }
    if (["workspace", "workspace_attempted"].includes(job.phase)) {
      const { workspaces } = await this.call((s) =>
        this.transport.rpc(job, "workspace.list", {}, s),
      );
      const matches = workspaces.filter((w) => w.label === job.label);
      if (matches.length > 1) throw new Error("ambiguous workspace identity");
      let workspace = matches[0];
      if (!workspace) {
        if (job.phase === "workspace_attempted") {
          this.save(job, {
            last_error:
              "Workspace creation outcome unknown; inspect Herdr before operator resolution",
          });
          return;
        }
        job = this.save(job, { phase: "workspace_attempted" });
        const m = job.machine_identity;
        const created = await this.call((s) =>
          this.transport.rpc(
            job,
            "workspace.create",
            {
              cwd: job.remote_worktree,
              label: job.label,
              focus: false,
              // Semantic inputs only. The execution runtime for every agent pane
              // belongs to the Drover node's own trusted shell initialisation.
              env: {
                FAMILIAR_AGENT_EXPECTED_MODEL: job.model,
                PI_CODING_AGENT_DIR: job.remote_profile ?? m.profile,
                ...(m.worker_env || {}),
              },
            },
            s,
          ),
        );
        workspace = created.workspace;
      }
      text(workspace?.workspace_id, 128, "workspace identity");
      job = this.save(job, {
        herdr_workspace_id: workspace.workspace_id,
        phase: "launch",
      });
    }
    if (["launch", "launch_attempted"].includes(job.phase)) {
      const { agents } = await this.call((s) =>
        this.transport.rpc(job, "agent.list", {}, s),
      );
      const matches = agents.filter((a) => a.name === job.herdr_agent_name);
      if (matches.length > 1) throw new Error("ambiguous agent identity");
      let agent = matches[0];
      if (!agent) {
        if (job.phase === "launch_attempted") {
          this.save(job, {
            last_error:
              "Launch outcome unknown; inspect Herdr, do not blindly relaunch",
          });
          return;
        }
        const { panes } = await this.call((s) =>
          this.transport.rpc(
            job,
            "pane.list",
            { workspace_id: job.herdr_workspace_id },
            s,
          ),
        );
        if (!Array.isArray(panes) || panes.length !== 1)
          throw new Error("dedicated pane unavailable");
        text(panes[0].pane_id, 128, "pane identity");
        job = this.save(job, {
          phase: "launch_attempted",
          herdr_pane_id: panes[0].pane_id,
          launch_attempted_at: Date.now(),
        });
        const started = await this.call((s) =>
          this.transport.rpc(
            job,
            "agent.start",
            {
              name: job.herdr_agent_name,
              kind: job.harness,
              pane_id: job.herdr_pane_id,
              args: [
                "--provider",
                modelSelection(job.model).provider,
                "--model",
                modelSelection(job.model).id,
                "--extension",
                modelGuardPath(job),
                ...(job.options?.thinking
                  ? ["--thinking", job.options.thinking]
                  : []),
              ],
              timeout_ms: 300000,
            },
            s,
          ),
        );
        agent = started.agent;
      }
      agent = agentObservation(agent);
      if (job.herdr_pane_id && agent.pane_id !== job.herdr_pane_id)
        throw new Error("launch pane changed");
      if (
        agent.workspace_id !== job.herdr_workspace_id ||
        agent.name !== job.herdr_agent_name
      )
        throw new Error("agent launch identity mismatch");
      // A launch-pending placeholder is a truthful pending startup, not an
      // interactive agent: it carries no `agent` kind and never becomes one when
      // the shell could not execute the harness. Report it as pending, and after
      // the grace period report the startup failure. Never relaunch.
      if (launchPendingPlaceholder(agent)) {
        job = this.save(job, {
          herdr_pane_id: agent.pane_id,
          herdr_pending_terminal_id: agent.terminal_id,
          launch_attempted_at: job.launch_attempted_at ?? Date.now(),
          last_error: null,
        });
        await this.observeLaunchPending(job);
        return;
      }
      if (agent.agent !== job.harness)
        throw new Error("agent launch identity mismatch");
      job = this.save(job, {
        herdr_agent_id: agent.terminal_id,
        herdr_pane_id: agent.pane_id,
        herdr_pending_terminal_id: null,
        agent_session: agent.agent_session ?? null,
        semantic_state:
          job.semantic_state === "cancel_requested"
            ? "cancel_requested"
            : "running",
        phase: "prompt",
      });
    }
    if (job.phase === "prompt" && job.semantic_state === "cancel_requested")
      job = this.save(job, { phase: "observe", prompt_delivery: "withheld" });
    if (job.phase === "prompt") {
      const { agent: rawAgent } = await this.call((s) =>
        this.transport.rpc(job, "agent.get", { target: job.herdr_pane_id }, s),
      );
      const agent = agentObservation(rawAgent);
      if (
        agent.name !== job.herdr_agent_name ||
        agent.workspace_id !== job.herdr_workspace_id ||
        agent.terminal_id !== job.herdr_agent_id
      )
        throw new Error("pre-prompt identity mismatch");
      if (
        agent.launch_pending ||
        !agent.interactive_ready ||
        !["idle", "done"].includes(agent.agent_status)
      )
        return;
      if ((agent.foreground_cwd ?? agent.cwd) !== job.remote_worktree)
        throw new Error("agent did not start in the provisioned worktree");
      const initial = prompt(job, job.task);
      job = this.save(job, { phase: "observe", prompt_delivery: "unknown" });
      await this.call((s) =>
        this.transport.rpc(
          job,
          "agent.prompt",
          { target: job.herdr_pane_id, text: initial },
          s,
        ),
      );
      job = this.save(job, { prompt_delivery: "delivered", task: null });
    }
    if (job.phase !== "observe") return;
    const { agents } = await this.call((s) =>
      this.transport.rpc(job, "agent.list", {}, s),
    );
    let agent = agents.find((a) => a.terminal_id === job.herdr_agent_id);
    if (!agent) {
      await this.observeGone(job);
      return;
    }
    agent = agentObservation(agent);
    if (
      agent.workspace_id !== job.herdr_workspace_id ||
      agent.pane_id !== job.herdr_pane_id ||
      agent.name !== job.herdr_agent_name ||
      agent.agent !== job.harness
    )
      throw new Error("agent identity mismatch");
    if (
      job.agent_session &&
      JSON.stringify(agent.agent_session) !== JSON.stringify(job.agent_session)
    )
      throw new Error(
        "agent session replaced; operator reconciliation required",
      );
    if (!job.agent_session && agent.agent_session)
      job = this.save(job, { agent_session: agent.agent_session });
    if (await this.deliverIntent(job, agent)) return;
    const read = await this.call((s) => this.transport.readSettlement(job, s));
    const status = agent.agent_status;
    if (
      read.raw !== undefined &&
      !job.intents.some((i) => !["delivered", "discarded"].includes(i.state)) &&
      ["idle", "done"].includes(status) &&
      !agent.launch_pending
    ) {
      try {
        const accepted = settlement(read.raw, job);
        // A second observation after the file read avoids accepting against the
        // stale pre-read working state. Herdr cannot provide a linearizable
        // cross-filesystem turn fence; settlement remains a trusted self-report.
        const { agent: rawAgain } = await this.call((s) =>
          this.transport.rpc(
            job,
            "agent.get",
            { target: job.herdr_pane_id },
            s,
          ),
        );
        const again = agentObservation(rawAgain);
        if (
          again.terminal_id !== agent.terminal_id ||
          again.name !== job.herdr_agent_name ||
          again.workspace_id !== job.herdr_workspace_id ||
          again.pane_id !== job.herdr_pane_id ||
          again.agent !== job.harness ||
          JSON.stringify(again.agent_session) !==
            JSON.stringify(agent.agent_session) ||
          again.state_change_seq !== agent.state_change_seq ||
          again.launch_pending ||
          !["idle", "done"].includes(again.agent_status)
        )
          return;
        const changes = {
          settlement_json: accepted,
          settlement_digest: digest(accepted),
          settlement_verdict: JSON.parse(accepted).verdict,
          semantic_state: "settled",
          settled_at: Date.now(),
          observation: "idle",
          task: null,
        };
        this.save(
          job,
          changes,
          this.note({ ...job, ...changes }, "settled", 2),
        );
        return;
      } catch (e) {
        if (e.message === "agents owner lease lost") throw e;
        job = this.save(job, {
          last_error:
            "Settlement rejected or recheck unavailable; remains unresolved",
        });
      }
    } else if (read.invalid)
      job = this.save(job, {
        last_error: "Settlement file rejected: size or format",
      });
    const observation =
      status === "working"
        ? "running"
        : status === "blocked"
          ? "blocked"
          : ["idle", "done"].includes(status)
            ? "idle"
            : "unknown";
    let next = { observation, last_state_seq: agent.state_change_seq };
    if (observation === "running" || observation === "blocked")
      next = { ...next, first_idle_observed_at: null };
    if (observation === "idle") {
      const fresh =
        job.observation !== "idle" ||
        job.first_idle_observed_at == null ||
        job.last_state_seq !== agent.state_change_seq;
      next = {
        ...next,
        first_idle_observed_at: fresh ? Date.now() : job.first_idle_observed_at,
        idle_episode: (job.idle_episode ?? 0) + (fresh ? 1 : 0),
      };
    }
    if (job.semantic_state !== "cancel_requested")
      next.semantic_state =
        observation === "idle"
          ? "idle_unsettled"
          : observation === "unknown"
            ? job.semantic_state
            : observation;
    let note;
    if (observation === "blocked") {
      next.blocked_seq = agent.state_change_seq;
      next.blocked_gap = job.observation_gap ?? 0;
      next.blocked_episode =
        (job.blocked_episode ?? 0) +
        (job.observation !== "blocked" ||
        job.blocked_seq !== agent.state_change_seq ||
        job.blocked_gap !== next.blocked_gap
          ? 1
          : 0);
      next.blocked_context = null;
      // Herdr has no typed question record. Raw terminal context is an explicit
      // enrollment opt-in; otherwise show native attach, not invented detail.
      if (job.machine_identity.capture_terminal_context === true) {
        const { read } = await this.call((s) =>
          this.transport.rpc(
            job,
            "agent.read",
            { target: job.herdr_pane_id, source: "recent", lines: 40 },
            s,
          ),
        );
        next.blocked_context =
          typeof read?.text === "string" ? read.text.slice(0, 4096) : null;
      }
      note = this.note(
        { ...job, ...next },
        `blocked-${next.blocked_episode}`,
        2,
      );
    } else next.blocked_context = null;
    if (
      observation === "idle" &&
      Date.now() - next.first_idle_observed_at >= this.idleGraceMs
    )
      note = this.note(
        { ...job, ...next },
        `idle-unsettled-${next.idle_episode}`,
      );
    this.save(job, next, note);
  }
  /** Herdr never reaps a placeholder whose startup failed (`bash: pi: command
   * not found` leaves the shell in the foreground forever), and the name stays
   * taken for that session. Report the failure once the grace has elapsed and
   * the pane proves no harness process exists; never relaunch it. */
  async observeLaunchPending(job) {
    const started = job.launch_attempted_at ?? Date.now();
    if (Date.now() - started < this.launchGraceMs) {
      this.save(job, { observation: "launch_pending", last_error: null });
      return;
    }
    const { process_info: p } = await this.call((s) =>
      this.transport.rpc(
        job,
        "pane.process_info",
        { pane_id: job.herdr_pane_id },
        s,
      ),
    );
    const foreground =
      p?.foreground_processes === undefined ? [] : p.foreground_processes;
    if (
      !Number.isSafeInteger(p?.shell_pid) ||
      p.shell_pid <= 0 ||
      !Number.isSafeInteger(p.foreground_process_group_id) ||
      !Array.isArray(foreground)
    )
      throw new Error("invalid process observation");
    if (
      p.foreground_process_group_id !== p.shell_pid ||
      foreground.some((x) => x?.pid !== p.shell_pid)
    ) {
      // Something is genuinely running; remain honestly pending.
      this.save(job, { observation: "launch_pending", last_error: null });
      return;
    }
    const changes = {
      phase: "launch_failed",
      observation: "launch_failed",
      last_error: `Agent startup failed: Herdr still reports a launch-pending placeholder for ${job.herdr_agent_name} while the dedicated pane has no harness process. The Herdr agent name stays taken for this session, so this job is never relaunched. Inspect the pane natively, then abandon this job and dispatch a fresh one once the node's agent runtime is correct.`,
    };
    this.save(
      job,
      changes,
      this.note({ ...job, ...changes }, "launch-failed", 2),
    );
  }
  async observeGone(job) {
    let reachability = "fresh";
    try {
      let read;
      try {
        read = await this.call((s) => this.transport.readSettlement(job, s));
      } catch (e) {
        reachability = "degraded";
        throw e;
      }
      if (
        read.raw !== undefined &&
        !job.intents.some((i) => !["delivered", "discarded"].includes(i.state))
      ) {
        const canonical = settlement(read.raw, job);
        const { workspaces } = await this.call((s) =>
          this.transport.rpc(job, "workspace.list", {}, s),
        );
        const workspace = workspaces.find(
          (w) => w.workspace_id === job.herdr_workspace_id,
        );
        if (workspace && workspace.label !== job.label)
          throw new Error("workspace identity changed");
        const { agents } = await this.call((s) =>
          this.transport.rpc(job, "agent.list", {}, s),
        );
        if (
          agents.some(
            (a) =>
              a.terminal_id === job.herdr_agent_id ||
              a.name === job.herdr_agent_name ||
              a.pane_id === job.herdr_pane_id,
          )
        )
          throw new Error(
            "agent identity reappeared or changed; inspect before settlement",
          );
        const changes = {
          semantic_state: "settled",
          observation: "gone",
          settlement_json: canonical,
          settlement_digest: digest(canonical),
          settlement_verdict: JSON.parse(canonical).verdict,
          settled_at: Date.now(),
          task: null,
        };
        this.save(
          job,
          changes,
          this.note({ ...job, ...changes }, "settled", 2),
        );
        return;
      }
    } catch (e) {
      this.guard();
    }
    const changes = {
      observation: "gone",
      semantic_state:
        job.semantic_state === "cancel_requested"
          ? "cancel_requested"
          : "idle_unsettled",
      reachability,
      last_error:
        "Agent disappeared; no accepted settlement. Inspect native state and settlement file before resolving.",
    };
    this.save(job, changes, this.note({ ...job, ...changes }, "gone"));
  }
  async deliverIntent(job, agent) {
    const intent = job.intents.find(
      (i) => !["delivered", "discarded"].includes(i.state),
    );
    if (!intent || intent.state !== "pending") return false; // Unknown delivery fences later intents.
    if (
      intent.kind === "answer" &&
      (agent.agent_status !== "blocked" ||
        intent.blocked_seq !== agent.state_change_seq ||
        intent.blocked_episode !== job.blocked_episode ||
        intent.observation_gap !== (job.observation_gap ?? 0))
    ) {
      this.save(job, {
        intents: job.intents.map((i) =>
          i.key === intent.key
            ? {
                ...i,
                state: "delivery_unknown",
                reason:
                  "Blocked episode changed or observation continuity was lost; inspect natively before resolving",
              }
            : i,
        ),
      });
      return true;
    }
    job = this.save(job, {
      intents: job.intents.map((i) =>
        i.key === intent.key ? { ...i, state: "delivery_unknown" } : i,
      ),
    });
    if (intent.kind === "cancel")
      await this.call((s) =>
        this.transport.rpc(
          job,
          "agent.send_keys",
          { target: job.herdr_pane_id, keys: ["Escape"] },
          s,
        ),
      );
    else if (intent.kind === "answer")
      await this.call((s) =>
        this.transport.rpc(
          job,
          "pane.send_input",
          { pane_id: job.herdr_pane_id, text: intent.text, keys: ["Enter"] },
          s,
        ),
      );
    else
      await this.call((s) =>
        this.transport.rpc(
          job,
          "agent.prompt",
          { target: job.herdr_pane_id, text: intent.text },
          s,
        ),
      );
    this.save(job, {
      intents: job.intents.map((i) =>
        i.key === intent.key ? { ...i, state: "delivered", text: null } : i,
      ),
    });
    return true;
  }
  /** Deny is explicit, deterministic and attributable as Agent policy. It is
   * never satisfiable from CLI/tool arguments: only persisted policy decides. */
  checkPolicy(model, machineId) {
    if (!this.policy)
      throw Object.assign(
        new Error(
          "Agent policy unavailable in this resident; dispatch denied (fail closed)",
        ),
        { code: "policy_denied" },
      );
    let decision;
    try {
      decision = this.policy.effective(model, machineId);
    } catch (error) {
      throw Object.assign(
        new Error(
          `Agent policy unreadable (${error.message}); dispatch denied (fail closed)`,
        ),
        { code: "policy_denied" },
      );
    }
    if (decision !== "allow")
      throw Object.assign(
        new Error(
          `Agent policy denies model ${model} on machine ${machineId}; enable that exact route for that exact machine first`,
        ),
        { code: "policy_denied" },
      );
  }
  dispatch(request, provenance) {
    this.guard();
    this.transport.admissionReady?.();
    const machine = this.transport.enrolled(request.machine_id);
    // v1's exact foreground launch args are Pi's. Never pretend arbitrary
    // harnesses share --model semantics; additional kinds need native proof.
    if (request.harness !== "pi" || !machine.models.includes(request.model))
      throw new Error("requested harness/model not explicitly enrolled");
    // Policy is enforced after exact enrollment validation and BEFORE any
    // durable admission or remote contact: a denial writes no ledger job.
    // A dispatch already admitted before a later toggle continues; only later
    // dispatches see the newer effective policy.
    this.checkPolicy(request.model, request.machine_id);
    const job = this.ledger.admit(this.fence, request, machine, provenance);
    this.kick();
    return projection(job);
  }
  intent(id, kind, value, key, actor) {
    this.guard();
    text(key, 256);
    if (!["steer", "answer", "cancel"].includes(kind))
      throw new Error("invalid intent");
    if (kind !== "cancel") text(value, 8192);
    const j = this.ledger.get(id);
    if (!j) throw new Error("unknown job");
    const prior = j.intents.find((i) => i.key === key);
    if (prior) {
      if (prior.kind !== kind || prior.digest !== digest(value))
        throw new Error("intent key conflict");
      return projection(j);
    }
    if (j.intents.length >= 128) throw new Error("intent bound");
    if (
      kind === "answer" &&
      (j.observation !== "blocked" || j.reachability !== "fresh")
    )
      throw new Error("answer requires a fresh observed blocked episode");
    const next = this.save(j, {
      semantic_state: kind === "cancel" ? "cancel_requested" : j.semantic_state,
      intents: [
        ...j.intents,
        {
          key,
          kind,
          text: value,
          digest: digest(value),
          state: "pending",
          blocked_seq: kind === "answer" ? j.blocked_seq : null,
          blocked_episode: kind === "answer" ? j.blocked_episode : null,
          observation_gap: j.observation_gap ?? 0,
          actor,
        },
      ],
    });
    this.kick();
    return projection(next);
  }
  resolveOperation(id, operation, resolution, reason, actor) {
    text(reason, 4096);
    const j = this.ledger.get(id);
    if (!j) throw new Error("unknown job");
    const attempted =
      operation === "prompt"
        ? j.prompt_delivery === "unknown"
        : j.phase === `${operation}_attempted`;
    if (!["workspace", "launch", "prompt"].includes(operation) || !attempted)
      throw new Error("no matching uncertain operation");
    if (
      !["retry-confirmed-absent", "prompt-confirmed-delivered"].includes(
        resolution,
      )
    )
      throw new Error("explicit native-inspection resolution required");
    if (resolution === "prompt-confirmed-delivered" && operation !== "prompt")
      throw new Error("only prompt delivery can be confirmed");
    if (
      j.semantic_state === "cancel_requested" &&
      resolution === "retry-confirmed-absent"
    )
      throw new Error(
        "cancelled dispatch cannot be newly launched or prompted",
      );
    const changes = {
      operation_resolution: {
        operation,
        resolution,
        reason,
        actor,
        at: Date.now(),
      },
      last_error: null,
    };
    if (resolution === "retry-confirmed-absent") changes.phase = operation;
    else {
      changes.prompt_delivery = "operator-confirmed";
      changes.task = null;
    }
    const next = this.save(j, changes);
    this.kick();
    return projection(next);
  }
  queueCleanup(id, actor) {
    this.guard();
    const j = this.ledger.get(id);
    if (!j || !terminal(j)) throw new Error("cleanup requires terminal job");
    if (j.cleanup_state === "complete")
      return { queued: false, complete: true, job_id: id };
    const days = this.transport.config?.remote_retention_days ?? 7;
    if (Date.now() - (j.settled_at ?? j.updated_at) < days * 86400000)
      throw new Error("remote retention period has not elapsed");
    this.ledger.update(
      this.fence,
      j,
      { cleanup_state: "requested", cleanup_actor: actor, cleanup_error: null },
      undefined,
      true,
    );
    this.kick();
    return { queued: true, job_id: id };
  }
  async cleanup(j) {
    try {
      if (!(await this.call((s) => this.transport.identity(j, s)))) return;
      const { agents } = await this.call((s) =>
        this.transport.rpc(j, "agent.list", {}, s),
      );
      const { workspaces } = await this.call((s) =>
        this.transport.rpc(j, "workspace.list", {}, s),
      );
      const matches = workspaces.filter(
        (w) =>
          w.label === j.label ||
          (j.herdr_workspace_id && w.workspace_id === j.herdr_workspace_id),
      );
      if (matches.length > 1) throw new Error("ambiguous cleanup workspace");
      const w = matches[0];
      if (
        w &&
        (w.label !== j.label ||
          (j.herdr_workspace_id && w.workspace_id !== j.herdr_workspace_id))
      )
        throw new Error("workspace identity changed");
      // Unknown create-result is reconciled by the unique durable label. Never
      // close an active agent or any differently named human workspace.
      const correlated = (a) =>
        a.name === j.herdr_agent_name ||
        (j.herdr_agent_id && a.terminal_id === j.herdr_agent_id) ||
        (j.herdr_pane_id && a.pane_id === j.herdr_pane_id);
      if (
        agents.some(
          (a) => correlated(a) && a.workspace_id !== w?.workspace_id,
        )
      )
        throw new Error("job agent moved; inspect before cleanup");
      if (w) {
        const workspaceAgents = agents.filter(
          (a) => a.workspace_id === w.workspace_id,
        );
        // A launch that never started leaves an unreapable placeholder: no
        // `agent` kind, `launch_pending`, `unknown` status, and no foreground
        // process at all. Closing that workspace is the only way to release the
        // name, so cleanup must accept exactly that proven-failed shape.
        const failedLaunch = (a) =>
          j.phase === "launch_failed" &&
          a.agent == null &&
          a.launch_pending === true &&
          a.agent_status === "unknown" &&
          a.name === j.herdr_agent_name &&
          a.pane_id === j.herdr_pane_id &&
          (!j.herdr_pending_terminal_id ||
            a.terminal_id === j.herdr_pending_terminal_id) &&
          !j.herdr_agent_id;
        if (
          workspaceAgents.length > 1 ||
          workspaceAgents.some(
            (a) =>
              !failedLaunch(a) &&
              (!correlated(a) ||
                a.name !== j.herdr_agent_name ||
                a.terminal_id !== j.herdr_agent_id ||
                a.pane_id !== j.herdr_pane_id ||
                a.agent !== j.harness ||
                !["idle", "done"].includes(a.agent_status) ||
                a.launch_pending ||
                (j.agent_session &&
                  JSON.stringify(a.agent_session) !==
                    JSON.stringify(j.agent_session))),
          )
        )
          throw new Error("active or replaced workspace");
        const { panes } = await this.call((s) =>
          this.transport.rpc(
            j,
            "pane.list",
            { workspace_id: w.workspace_id },
            s,
          ),
        );
        if (
          panes.length !== 1 ||
          (j.herdr_pane_id && panes[0].pane_id !== j.herdr_pane_id)
        )
          throw new Error("human changed workspace topology");
        const { process_info: p } = await this.call((s) =>
          this.transport.rpc(
            j,
            "pane.process_info",
            { pane_id: panes[0].pane_id },
            s,
          ),
        );
        // Herdr 0.9 serde-defaults this Vec and omits it on the wire when it is
        // empty. Treat omission exactly as [], but only shell-foreground PGID
        // evidence may make that otherwise information-poor observation safe.
        const foregroundProcesses =
          p?.foreground_processes === undefined ? [] : p.foreground_processes;
        if (
          !Number.isSafeInteger(p?.shell_pid) ||
          p.shell_pid <= 0 ||
          !Number.isSafeInteger(p.foreground_process_group_id) ||
          p.foreground_process_group_id <= 0 ||
          !Array.isArray(foregroundProcesses)
        )
          throw new Error("invalid process observation");
        const agent = workspaceAgents[0];
        if (!foregroundProcesses.length) {
          if (p.foreground_process_group_id !== p.shell_pid)
            throw new Error("human foreground process; cleanup refused");
        } else if (agent) {
          if (
            foregroundProcesses.length !== 1 ||
            !isManagedForegroundProcess(
              j,
              w,
              panes[0],
              p,
              agent,
              foregroundProcesses[0],
            )
          )
            throw new Error("unrecognized foreground process");
        } else if (p.foreground_process_group_id !== p.shell_pid)
          throw new Error("human foreground process; cleanup refused");
      }
      if (w)
        await this.call((s) =>
          this.transport.rpc(
            j,
            "workspace.close",
            { workspace_id: w.workspace_id },
            s,
          ),
        );
      const r = await this.call((s) =>
        this.transport.native(
          j,
          {
            operation: "cleanup",
            path: j.settlement_path,
            job_id: j.job_id,
            nonce: j.settlement_nonce,
          },
          s,
        ),
      );
      if (!r.complete) throw new Error("cleanup incomplete");
      this.ledger.update(
        this.fence,
        j,
        { cleanup_state: "complete", cleanup_error: null },
        undefined,
        true,
      );
    } catch {
      this.guard();
      this.ledger.update(
        this.fence,
        j,
        {
          cleanup_state: "needs_attention",
          cleanup_error:
            "Cleanup unresolved; retained files may include human changes. Inspect then explicitly retry.",
        },
        undefined,
        true,
      );
    }
    this.changed?.();
  }
  resolveIntent(id, key, reason, actor) {
    text(reason, 4096);
    const j = this.ledger.get(id);
    if (!j) throw new Error("unknown job");
    if (!j.intents.some((i) => i.key === key && i.state === "delivery_unknown"))
      throw new Error("no uncertain intent");
    const next = this.save(j, {
      intents: j.intents.map((i) =>
        i.key === key
          ? {
              ...i,
              state: "discarded",
              text: null,
              resolution: { actor, reason, at: Date.now() },
            }
          : i,
      ),
    });
    this.kick();
    return projection(next);
  }
  operatorSettle(id, verdict, summary, actor) {
    this.guard();
    const j = this.ledger.get(id);
    if (!j) throw new Error("unknown job");
    if (
      j.semantic_state === "settled" &&
      j.operator?.actor === actor &&
      j.settlement_json &&
      JSON.parse(j.settlement_json).verdict === verdict &&
      JSON.parse(j.settlement_json).summary === summary
    )
      return projection(j);
    const accepted = settlement(
      JSON.stringify({
        version: 1,
        job_id: id,
        nonce: j.settlement_nonce,
        verdict,
        summary,
        completed_at: new Date().toISOString(),
      }),
      j,
    );
    const changes = {
      semantic_state: "settled",
      settlement_json: accepted,
      settlement_digest: digest(accepted),
      settlement_verdict: verdict,
      settled_at: Date.now(),
      task: null,
      operator: {
        actor,
        at: Date.now(),
        reason: "explicit operator settlement; not agent self-report",
      },
    };
    return projection(
      this.save(j, changes, this.note({ ...j, ...changes }, "settled", 2)),
    );
  }
  abandon(id, reason, actor) {
    this.guard();
    text(reason, 4096);
    const j = this.ledger.get(id);
    if (!j) throw new Error("unknown job");
    if (
      j.semantic_state === "abandoned" &&
      j.operator?.actor === actor &&
      j.operator.reason === reason
    )
      return projection(j);
    const next = this.save(j, {
      semantic_state: "abandoned",
      operator: { actor, reason, at: Date.now() },
      task: null,
    });
    return projection(next);
  }
}
