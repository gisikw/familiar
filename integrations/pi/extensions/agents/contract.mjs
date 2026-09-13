import { createHash } from "node:crypto";
import { posix } from "node:path";

export const LIMITS = Object.freeze({
  active: 32,
  perMachine: 8,
  prompt: 32768,
  task: 24576,
  settlement: 32768,
  // Complete JSON request sent to remote.py; the profile source has its own
  // independent 64 KiB admission bound on the receiving side.
  nativeRequest: 131072,
  response: 1048576,
  callMs: 20000,
  leaseMs: 120000,
  idleGraceMs: 300000,
  // Herdr reports a launch-pending placeholder the moment `agent.start` types the
  // canonical executable into the pane shell, and never reaps it. A real harness
  // occupies the pane foreground within a second; this grace bounds how long a
  // truthful pending state may persist before startup is reported failed.
  launchGraceMs: 60000,
  concurrency: 4,
  retentionDays: 90,
});
export const terminal = (j) =>
  ["settled", "abandoned", "failed_admission"].includes(j.semantic_state);
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export function text(value, max, name = "text") {
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value) > max ||
    value.includes("\0")
  )
    throw new Error(`invalid ${name}`);
  return value;
}
function object(v, keys) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    throw new Error("invalid settlement object");
}
export function settlement(raw, job) {
  if (Buffer.byteLength(raw) > LIMITS.settlement)
    throw new Error("oversized settlement");
  const v = JSON.parse(raw);
  object(v, [
    "version",
    "job_id",
    "nonce",
    "verdict",
    "summary",
    "usage",
    "artifacts",
    "worktree",
    "completed_at",
  ]);
  if (
    v.version !== 1 ||
    v.job_id !== job.job_id ||
    v.nonce !== job.settlement_nonce
  )
    throw new Error("settlement correlation mismatch");
  if (!["done", "failed", "cancelled"].includes(v.verdict))
    throw new Error("invalid verdict");
  text(v.summary, 8192);
  text(v.completed_at, 64);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
      v.completed_at,
    ) ||
    !Number.isFinite(Date.parse(v.completed_at))
  )
    throw new Error("invalid completion time");
  const [year, month, day, hour, minute, second] = v.completed_at
    .slice(0, 19)
    .split(/[-T:]/)
    .map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day >
      [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    throw new Error("invalid calendar timestamp");
  if (v.usage !== undefined) {
    object(v.usage, ["input_tokens", "output_tokens", "cost_micros"]);
    for (const n of ["input_tokens", "output_tokens", "cost_micros"])
      if (!Number.isSafeInteger(v.usage[n]) || v.usage[n] < 0)
        throw new Error("invalid usage");
  }
  if (v.artifacts !== undefined) {
    if (!Array.isArray(v.artifacts) || v.artifacts.length > 32)
      throw new Error("invalid artifacts");
    for (const a of v.artifacts) {
      object(a, ["path", "description"]);
      text(a.path, 1024);
      text(a.description, 1024);
    }
  }
  if (v.worktree !== undefined) {
    object(v.worktree, ["path", "head", "dirty"]);
    text(v.worktree.path, 4096);
    text(v.worktree.head, 128);
    if (typeof v.worktree.dirty !== "boolean")
      throw new Error("invalid worktree");
  }
  // Stable key order at every depth; report paths are never executed or fetched.
  const canonical = (x) =>
    Array.isArray(x)
      ? x.map(canonical)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, canonical(x[k])]),
          )
        : x;
  return JSON.stringify(canonical(v));
}
export function prompt(job, task) {
  const value = `Familiar Agents v1 job ${job.job_id}\nSettlement nonce: ${job.settlement_nonce}\nExact settlement path: ${job.settlement_path}\n\nImplement, test, review and report the requested work. A human may attach, interrupt or steer you directly in Herdr; respect their instructions. Do NOT settle while blocked, interrupted, awaiting input, or before work and review are complete. Herdr idle is NOT completion. When complete, write a version 1 JSON self-report to a unique same-directory temporary file, flush/fsync, then atomically rename to settlement.json (optionally fsync the directory). No callback. Shape: {"version":1,"job_id":"${job.job_id}","nonce":"${job.settlement_nonce}","verdict":"done","summary":"bounded final report","completed_at":"RFC3339 timestamp"}. Verdict may also be failed or cancelled only as an explicit final self-report. Optional usage {input_tokens,output_tokens,cost_micros}, artifacts [{path,description}], worktree {path,head,dirty}. Maximum file 32768 bytes, summary 8192 bytes, artifacts 32. Each artifact path/description is at most 1024 bytes; worktree path is at most 4096 bytes and head 128 bytes. Usage fields must be nonnegative safe integers. Omit unavailable optional facts; do not invent usage or add other keys. Do not overwrite another accepted report.\n\nTask:\n${task}`;
  return text(value, LIMITS.prompt, "injected prompt");
}
export function modelSelection(value) {
  text(value, 256, "model");
  const slash = value.indexOf("/");
  if (
    slash < 1 ||
    slash === value.length - 1 ||
    !/^[-A-Za-z0-9_.]+$/.test(value.slice(0, slash)) ||
    /[\s*?\[\]]/.test(value)
  )
    throw new Error("exact provider/model required, not a model pattern");
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}
export function modelGuardPath(job) {
  return posix.join(posix.dirname(job.settlement_path), "model-guard.ts");
}
// Herdr 0.9 `agent.start --kind <harness>` types the *canonical* executable name
// into the dedicated pane's interactive shell; `AgentStartParams` carries no env,
// and the shell's own startup files own PATH by then. Supplying that runtime is
// the Drover/driver NODE's job, established by its own trusted shell
// initialisation for every Herdr agent pane. Familiar sends semantic inputs only
// and never probes, injects, selects or attests a pane environment.
/** Herdr returns a placeholder carrying the requested name, `launch_pending:
 * true`, `agent_status: "unknown"` and NO `agent` kind while startup is pending
 * or has already failed. That is a truthful pending state, not an agent. */
export function launchPendingPlaceholder(agent) {
  return (
    agent.launch_pending === true &&
    agent.agent === undefined &&
    agent.agent_status === "unknown" &&
    agent.state_change_seq === 0 &&
    agent.interactive_ready !== true &&
    agent.agent_session == null
  );
}
export function provisionedPaths(value, job) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          "remote_worktree",
          "settlement_path",
          "remote_profile",
          "resolved_head",
          "profile_digest",
        ].includes(k),
    )
  )
    throw new Error("invalid provision result");
  for (const k of ["remote_worktree", "settlement_path", "remote_profile"]) {
    text(value[k], 4096, k);
    if (!value[k].startsWith("/"))
      throw new Error("provision paths must be absolute");
  }
  const folder = posix.dirname(value.remote_worktree);
  if (
    posix.basename(folder) !== job.job_id ||
    posix.basename(value.remote_worktree) !== "worktree" ||
    value.settlement_path !== posix.join(folder, "settlement.json")
  )
    throw new Error("provision path correlation mismatch");
  const expectedProfile =
    job.machine_identity.profile_mode === "familiar-tiamat-v1"
      ? posix.join(folder, "profile")
      : posix.normalize(job.machine_identity.profile);
  if (posix.normalize(value.remote_profile) !== expectedProfile)
    throw new Error("profile identity mismatch");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.resolved_head))
    throw new Error("invalid resolved commit");
  if (
    value.profile_digest != null &&
    !/^[a-f0-9]{64}$/.test(value.profile_digest)
  )
    throw new Error("invalid profile digest");
  const result = {
    remote_worktree: value.remote_worktree,
    settlement_path: value.settlement_path,
    remote_profile: value.remote_profile,
    resolved_head: value.resolved_head,
    profile_digest: value.profile_digest ?? null,
  };
  for (const k of Object.keys(result))
    if (job[k] != null && job[k] !== result[k])
      throw new Error("durable provision plan changed");
  return result;
}
export function agentObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid Herdr agent");
  const out = {};
  for (const k of ["terminal_id", "workspace_id", "pane_id"])
    out[k] = text(value[k], 128, k);
  for (const k of ["name", "agent"])
    if (value[k] != null) out[k] = text(value[k], 32, k);
  for (const k of ["cwd", "foreground_cwd"])
    if (value[k] != null) out[k] = text(value[k], 4096, k);
  if (
    !["idle", "working", "blocked", "done", "unknown"].includes(
      value.agent_status,
    ) ||
    !Number.isSafeInteger(value.state_change_seq) ||
    value.state_change_seq < 0
  )
    throw new Error("invalid Herdr activity");
  out.agent_status = value.agent_status;
  out.state_change_seq = value.state_change_seq;
  for (const k of ["launch_pending", "interactive_ready"]) {
    if (value[k] !== undefined && typeof value[k] !== "boolean")
      throw new Error("invalid Herdr flag");
    out[k] = value[k] ?? false;
  }
  if (value.agent_session != null) {
    const s = value.agent_session;
    if (!["id", "path"].includes(s.kind))
      throw new Error("invalid Herdr session kind");
    out.agent_session = {
      source: text(s.source, 128),
      agent: text(s.agent, 32),
      kind: s.kind,
      value: text(s.value, 4096),
    };
  }
  return out;
}
export function privateSpanActive(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.customType === "familiar-ui/transcript-visibility")
      return e.data?.visibility === "private";
    if (e.type === "message" && e.message?.role === "user") return false;
  }
  return false;
}
export function projection(j) {
  return {
    job_id: j.job_id,
    machine_id: j.machine_id,
    label: j.label,
    repo: j.repo,
    requested_ref: j.requested_ref,
    harness: j.harness,
    model: j.model,
    options: j.options ?? {},
    semantic_state: j.semantic_state,
    reachability: j.reachability,
    observation: j.observation,
    phase: j.phase,
    prompt_delivery: j.prompt_delivery ?? null,
    operation_resolution: j.operation_resolution ?? null,
    blocked_episode: j.blocked_episode ?? null,
    blocked_context: j.blocked_context ?? null,
    last_error: j.last_error,
    updated_at: j.updated_at,
    first_idle_observed_at: j.first_idle_observed_at,
    remote_worktree: j.remote_worktree,
    herdr_workspace_id: j.herdr_workspace_id,
    herdr_agent_id: j.herdr_agent_id,
    attach_hint: `Run drover --config <operator-client-config> client (native Herdr UI); select machine ${j.machine_id}, session ${j.herdr_session}, space ${j.label}`,
    attach_target: {
      machine_id: j.machine_id,
      session: j.herdr_session,
      workspace_id: j.herdr_workspace_id,
      pane_id: j.herdr_pane_id,
    },
    settlement: j.settlement_json ? JSON.parse(j.settlement_json) : null,
    settlement_verdict: j.settlement_verdict ?? null,
    settlement_digest: j.settlement_digest ?? null,
    resolved_head: j.resolved_head ?? null,
    profile_digest: j.profile_digest ?? null,
    details_expired: j.retained_tombstone ?? false,
    owner_session: j.owner_session,
    operator: j.operator,
    cleanup_state: j.cleanup_state ?? null,
    cleanup_error: j.cleanup_error ?? null,
    pending_intent_count: (j.intents || []).filter(
      (i) => !["delivered", "discarded"].includes(i.state),
    ).length,
    pending_intents: (j.intents || [])
      .filter((i) => !["delivered", "discarded"].includes(i.state))
      .slice(0, 16)
      .map(({ key, kind, state }) => ({ key, kind, state })),
  };
}
