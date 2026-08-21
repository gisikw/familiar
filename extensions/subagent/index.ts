import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { prepareArtifactDir, getArtifactDir } from "./artifact-dir.ts";
import {
  registry as capabilities,
  WORKLIST_SINK,
  WORKLIST_SINK_VERSION,
  type DurableSink,
  type SinkPriority,
} from "../lib/capabilities.ts";

/* ============================================================================
 * Subagent extension — async work dispatch onto Herdr agents
 * ============================================================================
 *
 * The 10-second rule: any task expected to block conversation >~10s is a
 * dispatch. The familiar's own turn never becomes the blocking thread.
 *
 * Caller contract (stable; the reason this file can be rewritten freely):
 *   dispatch({ prompt, kind?, dir?, worktree?, model?, label?, timeout? })
 *     → { ok, id, pass, workspace, ... }   synchronous, never blocks on work
 *   subagent_await({ id?, timeout })       join: park until a settlement lands
 *   subagent_status({ id? })               look, don't block
 *   subagent_respond({ id, text })         answer or steer a live child
 *   subagent_cancel({ id })                kill and settle
 *   settlement, relayed into the conversation when work lands:
 *     { id, pass, status, reason?, result ≤2k, usage? }
 *
 * Implementation is Herdr, deliberately and exclusively (2026-08-19). Familiar
 * boots *through* Herdr; a second headless codepath would be a dead branch
 * preserving the illusion of portability rather than the fact of it. If Herdr
 * ever goes, we rewrite this layer against the contract above — which is the
 * part that was ever portable. FAMILIAR_SUBAGENT_MODE must be "herdr"; any
 * other value fails loudly. The error IS the degraded mode.
 *
 * Why panes instead of `pi -p`:
 *   - Kevin can click into a running job, watch it, steer it, rescue it.
 *   - `blocked` becomes real: Herdr detects the child asking a question, so
 *     mid-flight correction is a supported state instead of a wasted timeout.
 *   - Any Herdr-recognized agent kind can be dispatched, not just pi.
 *   - Waiting costs a parked process, not inference. Every architecture where
 *     waiting costs tokens eventually produces a model reinventing busy-wait.
 *
 * Topology — workspaces are keyed by working directory, not by job:
 *   - A job with worktree:true gets a Herdr worktree, which *is* its own
 *     workspace (checkout + workspace in one call). Edits are isolated; the
 *     branch is the artifact. This is the default for git repos.
 *   - A job without a worktree lands in the workspace for its cwd —
 *     found-or-created once and reused — as a new tab.
 *   Either way jobs appear in the left sidebar grouped by where they work,
 *   instead of littering the tab bar Kevin is using.
 *
 * The return channel: Herdr can block until an agent settles but cannot push
 * that transition anywhere. ./watcher.sh parks the blocking call in a detached
 * process and appends lifecycle transitions to events.ndjson. This extension
 * tails those files and turns them into settlements. Herdr needs no plugin; we
 * already own a resident process.
 *
 * Death and resurrection: pi children get *pre-minted session ids*, so a child
 * is not a process we hope survives — it is a session file we can relaunch.
 * /refamiliarize tears down the Herdr server and every pane with it; the next
 * session_start rebuilds the topology and runs pi against the same
 * --session-id, and the child resumes with its history intact. The spool
 * scan's job is resurrection, not triage.
 *
 * Invariants (ported from ~/Projects/herdr-flight/INVARIANTS.md):
 *   - The command is durable in the spool before side effects begin.
 *   - Ids are unique and immutable; (id, pass) settles at most once.
 *   - The watcher never exits without appending a terminal event.
 *   - Relay is idempotent via marker files.
 *
 * Spool layout, one directory per job under state/subagents/:
 *   command.json          durable dispatch record (written before side effects)
 *   prompt.txt            initial prompt as delivered
 *   prompt-<pass>.txt     later passes (respond)
 *   resume-prompt.txt     nudge delivered to a resurrected child
 *   pass                  current pass number
 *   workspace, tab, pane  live Herdr ids (rewritten on resurrection)
 *   events.ndjson         watcher-appended lifecycle transitions
 *   watcher.log           watcher diagnostics
 *   resumes               resurrection count (capped)
 *   settlement-<pass>.json
 *   relayed-<pass>        marker: settlement delivered to the conversation
 *   blocked-<pass>        marker: blocked interrupt delivered (not a settle)
 */

export type SettlementStatus = "done" | "crashed" | "timeout" | "blocked" | "cancelled";

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** Dollars, from pi's per-message cost accounting. */
  cost: number;
}

export interface DispatchCommand {
  id: string;
  pass: number;
  prompt: string;
  kind: string;
  /** Where the agent runs: the worktree checkout when isolated, else dir. */
  cwd: string;
  /** The directory the job was dispatched *for* — the workspace key. */
  origin: string;
  label: string;
  /** Dedicated worktree workspace (isolated edits) vs. a tab in a shared one. */
  isolated: boolean;
  branch?: string;
  model?: string;
  /** Pre-minted pi session id — the handle that makes children resurrectable. */
  session_id: string;
  /** argv passed to the agent binary after `--`. */
  agent_args: string[];
  /** Wall-clock seconds before the job is killed and settled as timeout. */
  timeout: number;
  created_at: string;
  /** Absolute path where the job should write substantial artifacts. */
  artifact_dir: string;
  extra?: Record<string, unknown>;
}

export interface Settlement {
  id: string;
  pass: number;
  status: SettlementStatus;
  reason?: string;
  /** Verdict, ≤ RESULT_MAX chars. */
  result: string;
  usage?: SubagentUsage;
  model?: string;
  /** Where to look: worktree checkout + branch for isolated jobs. */
  workdir?: string;
  branch?: string;
  /** Absolute path to the job's artifact directory. */
  artifact_dir?: string;
  settled_at: string;
}

interface WatcherEvent {
  at: string;
  /** Which pass emitted this. Events are pass-scoped; see eventsFor(). */
  pass?: number;
  phase: string;
  status: string;
  reason?: string;
}

const RESULT_MAX = 2000;
const POLL_MS = 2000;
const AWAIT_POLL_MS = 500;
const MAX_RESUMES = 2;
const DEFAULT_TIMEOUT_S = Number(process.env.FAMILIAR_SUBAGENT_TIMEOUT) || 1800;
const DEFAULT_MODEL = process.env.FAMILIAR_SUBAGENT_MODEL;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.dirname(HERE);
const REPO = path.dirname(EXT_DIR);
const WATCHER = path.join(HERE, "watcher.sh");
const MODE = process.env.FAMILIAR_SUBAGENT_MODE;
const ARTIFACT_ROOT = process.env.FAMILIAR_ARTIFACT_DIR || path.join(REPO, "state", "artifacts");

const SPOOL = process.env.FAMILIAR_SUBAGENT_DIR || path.join(REPO, "state", "subagents");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "~", ".pi", "agent");
const SESSION_DIR = process.env.FAMILIAR_SUBAGENT_SESSION_DIR || path.join(AGENT_DIR, "subagent-sessions");
const WS_REGISTRY = path.join(SPOOL, ".workspaces.json");

// Artifact root is created on first dispatch; subdirectories are per-job.
let artifactRootVerified = false;

/** Agent kind whose transcript we can read directly (and resume by session id). */
const NATIVE_KIND = "pi";

const verdictFooter = (kind: string, dir: string, artifactDir: string) =>
  "\n\n---\nYou are a dispatched subagent. Your final message is the only thing " +
  `returned to the dispatcher — a verdict, not a transcript (≤${RESULT_MAX} chars): ` +
  "what you did, what you concluded, what (if anything) failed." +
  "\n\n**Artifacts:** Write substantial non-code artifacts — research, design, " +
  `evidence, specs — to this directory (not /tmp or repo root): ${artifactDir}` +
  "\n**Code:** Changes belong in the worktree; they are the primary artifact." +
  "\n**Verdict:** List any artifact file paths you created." +
  (kind === NATIVE_KIND ? "" : `\nWrite that verdict to ${path.join(dir, "verdict.md")} as your final act.`);

const RESUME_PROMPT =
  "Your session was interrupted by an infrastructure restart, not by you — your " +
  "history above is intact. Resume the task you were given. If it was already " +
  "complete, restate your verdict now. Do not start over from scratch.";

/* --- spool ---------------------------------------------------------------- */

const jobDir = (id: string) => path.join(SPOOL, id);

const writeJSON = (file: string, obj: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file); // atomic: durable-before-side-effects hinges on this
};

const readJSON = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
};

const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
};

const mintId = (): string => {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const r = Math.random().toString(36).slice(2, 6);
  return `sub-${t}-${r}`;
};

const currentPass = (id: string): number => Number(readText(path.join(jobDir(id), "pass")).trim()) || 1;

const events = (id: string): WatcherEvent[] =>
  readText(path.join(jobDir(id), "events.ndjson"))
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as WatcherEvent];
      } catch {
        return [];
      }
    });

// Events from *this* pass only. One job writes one event log across every
// pass, so an unscoped read lets a previous pass's terminal event settle the
// current one instantly — harvesting the pre-steer verdict and stopping the
// poller before the real work finishes. Events predating pass-tagging are
// treated as pass 1.
const eventsFor = (id: string, pass: number): WatcherEvent[] =>
  events(id).filter((e) => (e.pass ?? 1) === pass);

/* --- herdr ---------------------------------------------------------------- */

const herdr = (args: string[]): any | null => {
  try {
    return JSON.parse(execFileSync("herdr", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    return null;
  }
};

/** Live agent record, or null if Herdr no longer knows this name. */
const agentState = (id: string): { status: string } | null => {
  const status = herdr(["agent", "get", id])?.result?.agent?.agent_status;
  return status ? { status } : null;
};

const agentTail = (id: string, lines = 40): string => {
  const res = herdr(["agent", "read", id, "--source", "recent-unwrapped", "--lines", String(lines)]);
  const text = res?.result?.content ?? res?.result?.text ?? "";
  return typeof text === "string" ? text.trim().slice(-1200) : "";
};

const gitRoot = (dir: string): string | null => {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

/* --- topology -------------------------------------------------------------- */
/* Workspaces are keyed by working directory and reused. Herdr owns the
 * sidebar; we only decide where a job belongs. All of this is synchronous and
 * fast — dispatch does it inline so the job has a home before it returns. */

/** Where a job's agent lives. `checkout` is set only for isolated worktree jobs. */
type Placement = { workspace: string; pane: string; tab: string; checkout?: string };
type Placed = Placement | { error: string };

const registry = (): Record<string, string> => readJSON<Record<string, string>>(WS_REGISTRY) || {};

const workspaceAlive = (ws: string): boolean => !!herdr(["workspace", "get", ws])?.result?.workspace;

/** Find-or-create the shared workspace for a directory, then add a tab to it. */
const placeInSharedWorkspace = (dir: string, label: string): Placed => {
  const reg = registry();
  let ws = reg[dir];

  if (ws && !workspaceAlive(ws)) ws = undefined as any;
  if (!ws) {
    // The current workspace already serves its own cwd; reuse rather than
    // spawning a duplicate of the room Kevin is standing in.
    const here = process.env.HERDR_WORKSPACE_ID;
    if (here && path.resolve(process.cwd()) === dir && workspaceAlive(here)) {
      ws = here;
    } else {
      const created = herdr(["workspace", "create", "--cwd", dir, "--label", path.basename(dir), "--no-focus"]);
      ws = created?.result?.workspace?.workspace_id;
      if (!ws) return { error: `workspace create failed for ${dir}` };
    }
    writeJSON(WS_REGISTRY, { ...registry(), [dir]: ws });
  }

  const tab = herdr(["tab", "create", "--workspace", ws, "--cwd", dir, "--label", label, "--no-focus"]);
  const pane = tab?.result?.root_pane?.pane_id;
  const tabId = tab?.result?.tab?.tab_id;
  if (!pane || !tabId) return { error: `tab create failed in ${ws}` };
  return { workspace: ws, pane, tab: tabId };
};

/** Create an isolated worktree; Herdr opens it as its own workspace. */
const placeInWorktree = (repo: string, branch: string, label: string): Placed => {
  const res = herdr(["worktree", "create", "--cwd", repo, "--branch", branch, "--label", label, "--no-focus"]);
  const ws = res?.result?.workspace?.workspace_id;
  const pane = res?.result?.root_pane?.pane_id;
  const tab = res?.result?.tab?.tab_id;
  const checkout = res?.result?.worktree?.path;
  if (!ws || !pane || !checkout) return { error: `worktree create failed for ${repo}#${branch}` };
  return { workspace: ws, pane, tab, checkout };
};

/** Reopen an existing worktree checkout as a workspace (resurrection path). */
const reopenWorktree = (repo: string, checkout: string, label: string): Placed => {
  const res = herdr(["worktree", "open", "--cwd", repo, "--path", checkout, "--label", label, "--no-focus"]);
  const ws = res?.result?.workspace?.workspace_id;
  const pane = res?.result?.root_pane?.pane_id;
  const tab = res?.result?.tab?.tab_id;
  if (!ws || !pane) return { error: `worktree open failed for ${checkout}` };
  return { workspace: ws, pane, tab };
};

const recordPlacement = (id: string, p: Placement) => {
  const dir = jobDir(id);
  fs.writeFileSync(path.join(dir, "workspace"), p.workspace);
  fs.writeFileSync(path.join(dir, "pane"), p.pane);
  if (p.tab) fs.writeFileSync(path.join(dir, "tab"), p.tab);
};

/** Retire a finished job's surface. Isolated workspaces survive: the branch is the artifact. */
const retire = (id: string, cmd: DispatchCommand, status: SettlementStatus) => {
  if (cmd.isolated) return; // leave the worktree workspace for inspection/merge
  if (status !== "done") return; // failures stay on screen so they can be read
  const tab = readText(path.join(jobDir(id), "tab")).trim();
  if (tab) herdr(["tab", "close", tab]);
};

const spawnWatcher = (id: string, phase: string, arg?: string) => {
  const child = spawn("bash", [WATCHER, jobDir(id), phase, ...(arg ? [arg] : [])], {
    cwd: jobDir(id),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
};

/* --- session transcript → verdict ------------------------------------------ */

/** pi writes <timestamp>_<session-id>.jsonl; the session id is ours, minted up front. */
const sessionFile = (sessionId: string): string | null => {
  try {
    const match = fs.readdirSync(SESSION_DIR).filter((f) => f.includes(sessionId)).sort();
    return match.length ? path.join(SESSION_DIR, match[match.length - 1]) : null;
  } catch {
    return null;
  }
};

function harvest(cmd: DispatchCommand): { result: string; usage?: SubagentUsage; model?: string } {
  let result = "";
  let model: string | undefined;
  const usage: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  let sawUsage = false;

  const file = cmd.kind === NATIVE_KIND ? sessionFile(cmd.session_id) : null;
  if (file) {
    for (const line of readText(file).split("\n")) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type !== "message" || ev.message?.role !== "assistant") continue;
      const msg = ev.message;
      const text = (Array.isArray(msg.content) ? msg.content : [])
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text)
        .join("");
      if (text.trim()) result = text;
      model = msg.model ?? model;
      const u = msg.usage;
      if (u) {
        sawUsage = true;
        usage.input += u.input ?? 0;
        usage.output += u.output ?? 0;
        usage.cacheRead += u.cacheRead ?? 0;
        usage.cacheWrite += u.cacheWrite ?? 0;
        usage.totalTokens += u.totalTokens ?? 0;
        usage.cost += u.cost?.total ?? 0;
      }
    }
  }

  // Non-pi kinds, or an unreadable transcript: the child was told to write its
  // verdict to a file. Failing that, scrape the pane.
  if (!result.trim()) result = readText(path.join(cmd.cwd, "verdict.md")).trim();
  if (!result.trim()) result = agentTail(cmd.id);

  if (result.length > RESULT_MAX) result = result.slice(0, RESULT_MAX) + "…";
  return { result, usage: sawUsage ? usage : undefined, model };
}

/* --- settle ---------------------------------------------------------------- */

/** Idempotent: an existing settlement for (id, pass) wins. */
function settle(cmd: DispatchCommand, pass: number, partial: Pick<Settlement, "status" | "reason">): Settlement {
  const file = path.join(jobDir(cmd.id), `settlement-${pass}.json`);
  const existing = readJSON<Settlement>(file);
  if (existing) return existing;
  const { result, usage, model } = harvest(cmd);
  const settlement: Settlement = {
    id: cmd.id,
    pass,
    status: partial.status,
    reason: partial.reason,
    result,
    usage,
    model,
    ...(cmd.isolated ? { workdir: cmd.cwd, branch: cmd.branch } : {}),
    ...(cmd.artifact_dir ? { artifact_dir: cmd.artifact_dir } : {}),
    settled_at: new Date().toISOString(),
  };
  writeJSON(file, settlement);
  return settlement;
}

export default function (pi: ExtensionAPI) {
  const pollers = new Map<string, ReturnType<typeof setInterval>>();

  /* --- worklist durable-sink seam --------------------------------------- */
  // Resolved at delivery time (never at load): worklist may be absent, may
  // register later, or may re-register across a /reload. Neither extension
  // imports the other; both depend only on the neutral capability registry.
  const resolveSink = (): DurableSink | undefined =>
    capabilities.resolve<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION);

  // failed/timeout are more urgent than a clean completion (candidate 4).
  const settlementPriority = (s: Settlement): SinkPriority => {
    switch (s.status) {
      case "crashed":
      case "timeout":
        return 1;
      case "cancelled":
        return 2;
      default:
        return 2; // done
    }
  };

  const settlementSummary = (s: Settlement): string => {
    const verb = s.status === "done" ? "settled" : s.status;
    const head = s.result ? s.result.split("\n")[0].slice(0, 80) : "(no output)";
    return `subagent ${s.id} ${verb}: ${head}`;
  };

  // Durable id for the worklist envelope: stable + pass-scoped so a re-relay is
  // idempotent and a later subagent_await can withdraw exactly this item.
  const worklistId = (s: Settlement): string => `subagent-${s.id}-${s.pass}`;
  const worklistedMarker = (id: string, pass: number) => path.join(jobDir(id), `worklisted-${pass}`);

  /* --- relay ------------------------------------------------------------- */

  // deliverAs steer + triggerTurn: lands after the current turn if one is
  // running, wakes the agent if idle. Returns whether delivery is confirmed —
  // a throwing sendMessage (e.g. mid-teardown) leaves no marker and retries.
  // Atomically take ownership of a delivery. Returns false when someone else
  // already has it. A tool result and the background poller can both be
  // holding the same settlement; exactly one of them may deliver it.
  const claim = (marker: string): boolean => {
    try {
      fs.writeFileSync(marker, "", { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };

  const send = (marker: string, lines: string[]): boolean => {
    if (fs.existsSync(marker)) return true;
    // Claim the marker *before* sending: relay() and subagent_await can race
    // for the same settlement, and a lost race means the verdict arrives
    // twice. Roll back if the send fails so the poller can retry.
    if (!claim(marker)) return true;
    try {
      pi.sendMessage(
        { customType: "subagent-settlement", content: lines.join("\n"), display: true },
        { deliverAs: "steer", triggerTurn: true },
      );
    } catch {
      try { fs.unlinkSync(marker); } catch { /* nothing to roll back */ }
      return false;
    }
    return true;
  };

  const settlementLines = (s: Settlement): string[] => [
    `<subagent-settlement id="${s.id}" pass="${s.pass}" status="${s.status}">`,
    ...(s.reason ? [`reason: ${s.reason}`] : []),
    s.result || "(no output)",
    ...(s.workdir ? [`workdir: ${s.workdir}${s.branch ? ` (branch ${s.branch})` : ""}`] : []),
    ...(s.artifact_dir ? [`artifacts: ${s.artifact_dir}`] : []),
    ...(s.usage
      ? [`usage: ${s.usage.input}in/${s.usage.output}out tokens, $${s.usage.cost.toFixed(4)}${s.model ? `, ${s.model}` : ""}`]
      : []),
    `</subagent-settlement>`,
  ];

  // Relay a settlement's visible delivery. Preferred path: route through the
  // worklist durable sink (attention policy decides WHEN it surfaces). Fallback:
  // direct steer relay when the sink is absent, rejects, or throws. Exactly-once
  // is arbitrated by the `relayed-<pass>` marker: whoever claims it owns
  // delivery; the losing channel does nothing. A worklisted settlement records
  // the `worklisted-<pass>` marker so subagent_await can withdraw it (see the
  // dedup invariant in worklist/PROTOCOL.md). Resolves true once delivery is
  // owned by SOME channel (so the poller can stop); false if it must retry.
  const relay = async (s: Settlement): Promise<boolean> => {
    const marker = path.join(jobDir(s.id), `relayed-${s.pass}`);
    if (fs.existsSync(marker)) return true;

    const sink = resolveSink();
    if (sink) {
      // Claim delivery ownership BEFORE enqueuing so a direct relay or an await
      // cannot also fire. Roll back on any failure and fall through to direct.
      if (!claim(marker)) return true;
      try {
        const acc = await sink.enqueue({
          id: worklistId(s),
          priority: settlementPriority(s),
          type: "notify",
          summary: settlementSummary(s),
          body: settlementLines(s).join("\n"),
          source: "subagent",
        });
        if (acc && acc.accepted) {
          // Worklist now owns visible delivery. Mark it so await can withdraw.
          try { fs.writeFileSync(worklistedMarker(s.id, s.pass), ""); } catch { /* best effort */ }
          return true;
        }
        if (acc && acc.superseded) {
          // Delivery already claimed elsewhere (an await withdrew this id while
          // our enqueue was in-flight). Do NOT fall back to a direct relay;
          // keep the relayed marker so nothing surfaces twice. Delivery owned.
          return true;
        }
        // Rejected: relinquish the claim and fall back to a direct relay.
        try { fs.unlinkSync(marker); } catch { /* nothing to roll back */ }
      } catch {
        try { fs.unlinkSync(marker); } catch { /* nothing to roll back */ }
      }
    }

    // Fallback: direct steer relay (worklist absent/rejected/errored).
    return send(marker, settlementLines(s));
  };

  // Fire relay without blocking the caller; stop the poller once delivery is
  // owned. Idempotent (marker-guarded), so repeated ticks are safe.
  const relayAsync = (s: Settlement, onDone?: (owned: boolean) => void) => {
    void relay(s)
      .then((owned) => onDone?.(owned))
      .catch(() => onDone?.(false));
  };

  // Blocked is an interrupt, not a settlement: the child is alive and waiting
  // on an answer. Relay the question, keep the job open, let respond() resume.
  const relayBlocked = (id: string, pass: number): boolean =>
    send(path.join(jobDir(id), `blocked-${pass}`), [
      `<subagent-blocked id="${id}" pass="${pass}">`,
      agentTail(id) || "(agent is blocked; pane produced no readable tail)",
      `Answer with subagent_respond({ id: "${id}", text: ... }) or cancel it.`,
      `</subagent-blocked>`,
    ]);

  const stopPolling = (id: string) => {
    const t = pollers.get(id);
    if (t) clearInterval(t);
    pollers.delete(id);
  };

  /* --- monitor ------------------------------------------------------------ */

  // Tail the watcher's event log and turn transitions into settlements. The
  // poller stops only once the relay marker is on disk: settling and
  // delivering are separate steps, and a failed relay retries every tick.
  const monitor = (id: string) => {
    if (pollers.has(id)) return;
    const dir = jobDir(id);
    const cmd = readJSON<DispatchCommand>(path.join(dir, "command.json"));
    if (!cmd) return;

    const finish = (pass: number, status: SettlementStatus, reason?: string) => {
      retire(id, cmd, status);
      relayAsync(settle(cmd, pass, { status, reason }), (owned) => { if (owned) stopPolling(id); });
    };

    // Each pass gets its own deadline: a steered or resurrected job is
    // legitimately still working long after the original dispatch, and must
    // not be force-killed because the first pass's budget elapsed.
    const passStartedAt = (pass: number): number => {
      const first = eventsFor(id, pass)[0];
      const stamp = readText(path.join(dir, `started-${pass}`)).trim();
      if (stamp) return Date.parse(stamp);
      if (first) return Date.parse(first.at);
      return Date.parse(cmd.created_at);
    };

    const tick = () => {
      const pass = currentPass(id);
      const existing = readJSON<Settlement>(path.join(dir, `settlement-${pass}.json`));
      if (existing) {
        relayAsync(existing, (owned) => { if (owned) stopPolling(id); });
        return;
      }

      const last = eventsFor(id, pass).at(-1);

      if (last) {
        if (last.status === "blocked") {
          relayBlocked(id, pass); // interrupt, not settle: the job stays open
          return;
        }
        if (last.status === "done" || last.status === "idle") return finish(pass, "done");
        if (last.status === "unknown") {
          // Herdr says `unknown` does not prove completion, so only treat it
          // as terminal once the agent is actually gone from the session.
          if (agentState(id)) return;
          return finish(pass, "done", "agent state unclassified; verdict harvested from transcript");
        }
        if (last.status === "error") {
          const timedOut = /timeout/i.test(last.reason ?? "");
          return finish(pass, timedOut ? "timeout" : "crashed", last.reason ?? "watcher reported an error");
        }
      }

      // Backstop: the watcher enforces its own timeout, but if the watcher
      // itself died the job must not sit open forever.
      if (Date.now() > passStartedAt(pass) + (cmd.timeout + 120) * 1000) {
        finish(pass, "timeout", `exceeded ${cmd.timeout}s (watcher silent)`);
      }
    };

    const tickGuarded = () => {
      // A throw here would kill the interval silently and strand the job.
      try {
        tick();
      } catch {
        /* transient: disk hiccup, torn write. Next tick retries. */
      }
    };

    pollers.set(id, setInterval(tickGuarded, POLL_MS));
    tickGuarded();
  };

  /* --- resurrection ------------------------------------------------------- */

  // A child is not a process we hope survives; it is a session file we can
  // relaunch. Herdr's panes die with the server (every /refamiliarize), so
  // rebuild the topology and run pi against the same --session-id.
  //
  // Returns an error string, or null once the topology is ready for a watcher.
  // Shared by the startup spool scan and by respond(): a child that died is
  // not a dead end, because its history is a file.
  const reviveTopology = (cmd: DispatchCommand): string | null => {
    const dir = jobDir(cmd.id);
    if (cmd.kind !== NATIVE_KIND) return `${cmd.kind} agent lost with its pane; not resumable`;
    const resumes = Number(readText(path.join(dir, "resumes")).trim()) || 0;
    if (resumes >= MAX_RESUMES) return `abandoned after ${resumes} resurrection attempts`;

    const label = `${cmd.label} ↺`;
    const placed = cmd.isolated
      ? reopenWorktree(cmd.origin, cmd.cwd, label)
      : placeInSharedWorkspace(cmd.cwd, label);
    if ("error" in placed) return placed.error;

    fs.writeFileSync(path.join(dir, "resumes"), String(resumes + 1));
    recordPlacement(cmd.id, placed);
    return null;
  };

  const resurrect = (cmd: DispatchCommand) => {
    const dir = jobDir(cmd.id);
    const pass = currentPass(cmd.id);

    const error = reviveTopology(cmd);
    if (error) {
      const s = settle(cmd, pass, { status: "crashed", reason: `resurrection failed: ${error}` });
      relayAsync(s, (owned) => { if (!owned) monitor(cmd.id); });
      return;
    }

    fs.writeFileSync(path.join(dir, "resume-prompt.txt"), RESUME_PROMPT);
    // The revived pass starts its clock now: the original budget was spent by
    // a life that no longer exists.
    fs.writeFileSync(path.join(dir, `started-${pass}`), new Date().toISOString());
    spawnWatcher(cmd.id, "resume");
    monitor(cmd.id);
  };

  /* --- tools --------------------------------------------------------------- */

  const requireHerdr = (): string | null => {
    if (MODE !== "herdr") return `FAMILIAR_SUBAGENT_MODE is ${MODE ? `"${MODE}"` : "unset"}; subagent dispatch requires "herdr"`;
    if (!process.env.HERDR_WORKSPACE_ID) return "not running inside a Herdr workspace";
    return null;
  };

  const fail = (error: string, extra: Record<string, unknown> = {}) => ({
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error, ...extra }) }],
    isError: true,
  });

  const ok = (obj: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ...obj }) }],
  });

  pi.registerTool({
    name: "dispatch",
    label: "Dispatch Subagent",
    description:
      "Dispatch work to an async subagent running in its own Herdr pane. Returns { ok, id, pass, artifact_dir } immediately; " +
      "the settlement (verdict ≤2k chars, token/dollar usage, artifact paths) is relayed into the conversation when the work " +
      "lands. Use for anything expected to take >10 seconds. Do not poll or sleep waiting for it — go do other " +
      "work, and call subagent_await when you actually need the result. Git repos get an isolated worktree by " +
      "default (its branch is the artifact). The child starts cold: include all needed context in the prompt. " +
      "Substantial non-code artifacts go to a dedicated artifact directory.",
    promptSnippet: "Dispatch async work to a subagent; settlement relays back on completion",
    parameters: Type.Object({
      prompt: Type.String({ description: "Complete task description — the child has no other context" }),
      label: Type.Optional(Type.String({ description: "Short label so the job is recognizable in the sidebar" })),
      dir: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
      worktree: Type.Optional(Type.Boolean({ description: "Isolate edits in a git worktree (default: true inside a git repo). Set false for read-only or ephemeral work." })),
      model: Type.Optional(Type.String({ description: `Model for the child as provider/id, e.g. "anthropic/claude-haiku-4-5" (default: ${DEFAULT_MODEL || "pi's default"}). Use a cheap model for mechanical work.` })),
      kind: Type.Optional(Type.String({ description: "Herdr agent kind (default: pi). Non-pi kinds cannot be resumed after a restart." })),
      timeout: Type.Optional(Type.Integer({ description: `Seconds before kill+timeout settle (default ${DEFAULT_TIMEOUT_S})` })),
    }),
    async execute(_toolCallId, params: Record<string, any>) {
      const gate = requireHerdr();
      if (gate) return fail(gate);

      const { prompt, label, dir, worktree, model, kind, timeout, ...extra } = params;
      const id = mintId();
      const pass = 1;
      const dirPath = jobDir(id);
      const agentKind = kind || NATIVE_KIND;
      const sessionId = randomUUID();
      const origin = path.resolve(dir || process.cwd());
      const repo = gitRoot(origin);
      const isolated = worktree ?? !!repo;
      const shortLabel = label || id.replace(/^sub-\d{8}-/, "");

      if (isolated && !repo) return fail(`worktree requested but ${origin} is not a git repository`);

      fs.mkdirSync(dirPath, { recursive: true });
      fs.mkdirSync(SESSION_DIR, { recursive: true });

      // Prepare artifact directory before dispatch (durable, idempotent)
      const artifactPrep = prepareArtifactDir(ARTIFACT_ROOT, id, true);
      if (artifactPrep.error) {
        console.warn(`artifact dir creation warning: ${artifactPrep.error}`);
      }
      artifactRootVerified = true;

      const branch = `sub/${shortLabel.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40)}-${id.slice(-4)}`;
      const placed = isolated
        ? placeInWorktree(repo!, branch, shortLabel)
        : placeInSharedWorkspace(origin, shortLabel);
      if ("error" in placed) return fail(placed.error, { id });

      const cwd = placed.checkout ?? origin;
      const childModel = model || DEFAULT_MODEL;
      const command: DispatchCommand = {
        id,
        pass,
        prompt,
        kind: agentKind,
        cwd,
        origin: repo || origin,
        label: shortLabel,
        isolated,
        ...(isolated ? { branch } : {}),
        model: childModel,
        session_id: sessionId,
        artifact_dir: artifactPrep.dir,
        agent_args: agentKind === NATIVE_KIND
          ? [
              "--no-extensions",
              "-e", path.join(EXT_DIR, "anthropic-gateway.ts"),
              "-e", path.join(EXT_DIR, "web.ts"),
              "--no-skills",
              "--no-context-files",
              "--session-dir", SESSION_DIR,
              "--session-id", sessionId,
              ...(childModel ? ["--model", childModel] : []),
            ]
          : [],
        timeout: timeout || DEFAULT_TIMEOUT_S,
        created_at: new Date().toISOString(),
        ...(Object.keys(extra).length ? { extra } : {}),
      };

      // Durable before the slow side effects begin.
      const promptWithArtifact = prompt + verdictFooter(agentKind, cwd, artifactPrep.dir);
      fs.writeFileSync(path.join(dirPath, "prompt.txt"), promptWithArtifact);
      fs.writeFileSync(path.join(dirPath, "pass"), String(pass));
      fs.writeFileSync(path.join(dirPath, `started-${pass}`), new Date().toISOString());
      writeJSON(path.join(dirPath, "command.json"), command);
      recordPlacement(id, placed);

      spawnWatcher(id, "launch");
      monitor(id);
      return ok({
        id,
        pass,
        label: shortLabel,
        artifact_dir: artifactPrep.dir,
        workspace: placed.workspace,
        ...(isolated ? { workdir: cwd, branch } : { dir: cwd }),
      });
    },
  });

  pi.registerTool({
    name: "subagent_await",
    label: "Await Subagent",
    description:
      "Block until a dispatched subagent settles (or becomes blocked on a question), then return its outcome. " +
      "This is the join primitive: dispatch work, keep working, and call this only when you genuinely need the " +
      "result before continuing. Never sleep or poll manually — this call costs no tokens while it waits. " +
      "Omit id to wait for the next settlement among all running jobs.",
    promptSnippet: "Block until a subagent settles and return its verdict",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Job id; omit to await the next settlement of any running job" })),
      timeout: Type.Optional(Type.Integer({ description: "Seconds to wait before giving up (default 600). Giving up does not cancel the job." })),
    }),
    async execute(_toolCallId, params: { id?: string; timeout?: number }) {
      const gate = requireHerdr();
      if (gate) return fail(gate);

      const settlementOf = (id: string) =>
        readJSON<Settlement>(path.join(jobDir(id), `settlement-${currentPass(id)}.json`));

      if (params.id && !readJSON(path.join(jobDir(params.id), "command.json"))) return fail("unknown id");

      const watched = params.id
        ? [params.id]
        : fs.existsSync(SPOOL)
          ? fs.readdirSync(SPOOL).filter((d) =>
              readJSON(path.join(jobDir(d), "command.json")) && !settlementOf(d))
          : [];

      if (!watched.length) {
        // Nothing outstanding: if a specific id was named it has already
        // settled, so hand back the settlement rather than an error.
        const s = params.id ? settlementOf(params.id) : null;
        if (s) return ok({ id: s.id, pass: s.pass, status: s.status, reason: s.reason, result: s.result, usage: s.usage, ...(s.artifact_dir ? { artifact_dir: s.artifact_dir } : {}) });
        return fail("no running subagents to await");
      }

      const deadline = Date.now() + (params.timeout || 600) * 1000;
      for (;;) {
        for (const id of watched) {
          const pass = currentPass(id);
          const s = readJSON<Settlement>(path.join(jobDir(id), `settlement-${pass}.json`));
          if (s) {
            // Exactly-once dedup: this settlement may already be queued in the
            // worklist (relay routed it through the durable sink). await is
            // taking ownership of delivery here, so the queued item MUST NOT
            // surface later. Withdraw it before returning the verdict.
            //   withdraw() true  → item was undelivered (or never existed): we
            //                      now own the single surface (this tool result)
            //   withdraw() false → worklist ALREADY delivered it: do not repeat
            //                      the body; point at the prior delivery instead
            let alreadySurfaced = false;
            const sink = resolveSink();
            if (sink) {
              // Always attempt withdraw when a sink is present, even if the
              // `worklisted` marker is not yet on disk: relay's enqueue may be
              // in-flight. withdraw sets a tombstone that also refuses a late
              // enqueue, closing the race in both orderings.
              try {
                const removed = await sink.withdraw(worklistId(s));
                alreadySurfaced = removed === false;
              } catch {
                /* sink error: fall through; marker+relayed guard below */
              }
            }
            claim(path.join(jobDir(id), `relayed-${pass}`)); // this result IS the relay
            stopPolling(id);
            if (alreadySurfaced) {
              return ok({
                id: s.id, pass: s.pass, status: s.status, reason: s.reason,
                note: "verdict already delivered to the conversation via the worklist; not repeated here",
                ...(s.artifact_dir ? { artifact_dir: s.artifact_dir } : {}),
              });
            }
            return ok({
              id: s.id, pass: s.pass, status: s.status, reason: s.reason,
              result: s.result, usage: s.usage,
              ...(s.workdir ? { workdir: s.workdir, branch: s.branch } : {}),
              ...(s.artifact_dir ? { artifact_dir: s.artifact_dir } : {}),
            });
          }
          if (eventsFor(id, pass).at(-1)?.status === "blocked") {
            claim(path.join(jobDir(id), `blocked-${pass}`));
            return ok({ id, pass, status: "blocked", tail: agentTail(id), note: "answer with subagent_respond" });
          }
        }
        if (Date.now() > deadline) {
          return ok({ status: "waiting", note: `still running after ${params.timeout || 600}s; not cancelled`, ids: watched });
        }
        await new Promise((r) => setTimeout(r, AWAIT_POLL_MS));
      }
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent Status",
    description: "List dispatched subagents and their status (running, blocked, or settled). Optionally filter by id. Does not block — use subagent_await for that.",
    promptSnippet: "List dispatched subagents and their settlement status",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Single job id to inspect" })),
    }),
    async execute(_toolCallId, params: { id?: string }) {
      const ids = params.id
        ? [params.id]
        : fs.existsSync(SPOOL)
          ? fs.readdirSync(SPOOL).filter((d) => fs.existsSync(path.join(SPOOL, d, "command.json"))).sort()
          : [];
      const jobs = ids.map((id) => {
        const cmd = readJSON<DispatchCommand>(path.join(jobDir(id), "command.json"));
        if (!cmd) return { id, error: "unknown id" };
        const pass = currentPass(id);
        const s = readJSON<Settlement>(path.join(jobDir(id), `settlement-${pass}.json`));
        const last = eventsFor(id, pass).at(-1);
        return {
          id,
          pass,
          label: cmd.label,
          status: s?.status ?? (last?.status === "blocked" ? "blocked" : agentState(id)?.status ?? "starting"),
          created_at: cmd.created_at,
          ...(cmd.isolated ? { branch: cmd.branch, workdir: cmd.cwd } : {}),
          ...(cmd.artifact_dir ? { artifact_dir: cmd.artifact_dir } : {}),
          ...(s ? { settled_at: s.settled_at, usage: s.usage } : {}),
          prompt: cmd.prompt.length > 120 ? cmd.prompt.slice(0, 120) + "…" : cmd.prompt,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "subagent_respond",
    label: "Respond to Subagent",
    description:
      "Answer a blocked subagent, or send follow-up instructions to one still running (steering it mid-flight). " +
      "Opens a new pass on the same job; the next settlement relays back as usual.",
    promptSnippet: "Send text to a running or blocked subagent",
    parameters: Type.Object({
      id: Type.String({ description: "Job id from dispatch" }),
      text: Type.String({ description: "Answer or follow-up instruction for the child" }),
    }),
    async execute(_toolCallId, params: { id: string; text: string }) {
      const gate = requireHerdr();
      if (gate) return fail(gate);

      const dir = jobDir(params.id);
      const cmd = readJSON<DispatchCommand>(path.join(dir, "command.json"));
      if (!cmd) return fail("unknown id");

      // A settled or reaped child still has its transcript, and pi children
      // carry pre-minted session ids precisely so history outlives the pane.
      // Refusing here would strand recoverable work behind an error message.
      const revived = !agentState(params.id);
      if (revived) {
        const error = reviveTopology(cmd);
        if (error) return fail(`agent is gone and could not be revived: ${error}`, { id: params.id });
      }

      const pass = currentPass(params.id) + 1;
      fs.writeFileSync(path.join(dir, `prompt-${pass}.txt`), params.text);
      fs.writeFileSync(path.join(dir, "pass"), String(pass));
      fs.writeFileSync(path.join(dir, `started-${pass}`), new Date().toISOString());
      // revive relaunches pi first; respond talks to an agent already standing.
      spawnWatcher(params.id, revived ? "revive" : "respond", String(pass));
      monitor(params.id);
      return ok({ id: params.id, pass, ...(revived ? { revived: true } : {}) });
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagent",
    description: "Cancel a running subagent by id. Stops the agent and settles the job as cancelled with whatever verdict exists. An isolated job's worktree and branch survive; artifacts are preserved.",
    promptSnippet: "Cancel a running subagent",
    parameters: Type.Object({
      id: Type.String({ description: "Job id from dispatch" }),
    }),
    async execute(_toolCallId, params: { id: string }) {
      const dir = jobDir(params.id);
      const cmd = readJSON<DispatchCommand>(path.join(dir, "command.json"));
      if (!cmd) return fail("unknown id");
      const pass = currentPass(params.id);
      const already = readJSON<Settlement>(path.join(dir, `settlement-${pass}.json`));
      if (already) return ok({ id: params.id, pass, status: already.status, note: "already settled", ...(already.artifact_dir ? { artifact_dir: already.artifact_dir } : {}) });

      // Interrupt first so the verdict harvest sees a quiescent agent, then
      // close only the surfaces we own: a shared-workspace job loses its tab;
      // an isolated job keeps its workspace so the branch can be inspected.
      herdr(["agent", "send-keys", params.id, "ctrl+c"]);
      const s = settle(cmd, pass, { status: "cancelled", reason: "cancelled by dispatcher" });
      const tab = readText(path.join(dir, "tab")).trim();
      if (!cmd.isolated && tab) herdr(["tab", "close", tab]);
      stopPolling(params.id);
      claim(path.join(dir, `relayed-${pass}`)); // the tool result IS the relay
      return ok({ id: s.id, pass: s.pass, status: s.status, result: s.result, ...(s.workdir ? { workdir: s.workdir, branch: s.branch } : {}), ...(s.artifact_dir ? { artifact_dir: s.artifact_dir } : {}) });
    },
  });

  /* --- reconciliation ------------------------------------------------------ */

  // The spool scan resurrects, it doesn't just triage. Panes die with the Herdr
  // server on every /refamiliarize; pi sessions don't.
  pi.on("session_start", async () => {
    if (MODE !== "herdr" || !fs.existsSync(SPOOL)) return;

    // Verify/create artifact root once per session
    if (!artifactRootVerified) {
      try {
        if (!fs.existsSync(ARTIFACT_ROOT)) {
          fs.mkdirSync(ARTIFACT_ROOT, { recursive: true, mode: 0o700 });
        }
        artifactRootVerified = true;
      } catch (err) {
        console.warn(`failed to verify artifact root ${ARTIFACT_ROOT}: ${err}`);
      }
    }

    for (const id of fs.readdirSync(SPOOL)) {
      const cmd = readJSON<DispatchCommand>(path.join(jobDir(id), "command.json"));
      if (!cmd) continue;
      const pass = currentPass(id);

      // Ensure old jobs without artifact_dir have a deterministic fallback
      if (!cmd.artifact_dir) {
        cmd.artifact_dir = getArtifactDir(ARTIFACT_ROOT, id);
        // Don't write back; it's computed on-demand. But do ensure the dir exists.
        const prep = prepareArtifactDir(ARTIFACT_ROOT, id, false);
        if (!prep.error) {
          // Update the in-memory command for this session
          cmd.artifact_dir = prep.dir;
        }
      }

      const settlement = readJSON<Settlement>(path.join(jobDir(id), `settlement-${pass}.json`));
      if (settlement) {
        relayAsync(settlement, (owned) => { if (!owned) monitor(id); }); // no-op when marker exists
        continue;
      }

      const live = agentState(id);
      if (live) {
        // Survived a plain pi restart (not a Herdr teardown): re-park a
        // watcher; a blocked child gets its question re-raised.
        if (live.status === "blocked") relayBlocked(id, pass);
        else spawnWatcher(id, "attach");
        monitor(id);
        continue;
      }

      resurrect(cmd);
    }
  });

  pi.on("session_shutdown", async () => {
    for (const id of [...pollers.keys()]) stopPolling(id);
    // Children keep running; the next session adopts or resurrects them.
  });
}
