import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/* ============================================================================
 * Subagent extension — async work dispatch
 * ============================================================================
 *
 * The 10-second rule: any task expected to block conversation >~10s is a
 * dispatch. The familiar's own turn never becomes the blocking thread.
 *
 * Contract (agreed 2026-08-17, amended 2026-08-17 evening):
 *   dispatch({ prompt, host?, dir?, worktree?, timeout?, ...preserved })
 *     → { ok, id, pass }          — synchronous, never blocks on the work
 *   async settlement (relayed into the conversation when it lands):
 *     { id, pass, status, reason?, result ≤2k, artifacts?, usage? }
 *   cancel(id) now; respond(id, text) reserved (blocked ⇒ resumable — the
 *   floor cannot produce "blocked"; the status exists for the ceiling).
 *
 * The id is composite: (id, pass). Pass 1 is the initial run; respond() and
 * future retry/rollup actions will mint higher passes against the same id.
 * Settlements and relay markers are per-pass.
 *
 * Result is a *verdict, not a transcript* (dead-fallacy doctrine): the child
 * is instructed to report a bounded conclusion and write anything substantial
 * to files. Sub-agents return artifacts, not experience. The `artifacts`
 * field is schema-reserved; the floor leaves paths in the verdict text.
 *
 * Invariants (ported from ~/Projects/herdr-flight/INVARIANTS.md):
 *   - The command is durable in the spool before side effects begin.
 *   - Ids are unique and immutable.
 *   - Dispatch is a doorbell: the child redirects its own output to spool
 *     files and survives invoker death; session_start reconciles orphans.
 *   - Settling an already-settled (id, pass) is harmless; relay is
 *     idempotent via marker files.
 *
 * Floor: spawns `pi --mode json -p` locally (headless; exits on settle; the
 * JSON event stream carries per-message token usage and dollar cost, which
 * is where `usage` comes from). Children run --no-extensions with only the
 * anthropic-gateway and web extensions loaded explicitly: the subscriber
 * would fight over its port, orientation would burn a turn, and identity
 * doesn't belong in a work drone.
 *
 * Child sessions persist under their own directory (subagent-sessions/, not
 * the main sessions/): the main line resumes via `pi --continue`, which
 * picks the most recent session — a child session in the primary directory
 * could get resumed *as the familiar* after a bounce. Separation is
 * correctness, not tidiness. Persisted child sessions are also the path to
 * respond(id) later.
 *
 * Ceiling (not this file): FAMILIAR_HERDR_CLUSTERS rpc relays — same
 * contract, spool format shared with herdr-flight. `host` is accepted and
 * preserved now so the params shape doesn't change later.
 *
 * Spool layout, one directory per job under state/subagents/:
 *   command.json        durable dispatch record (written before spawn)
 *   pid                 child process id (written after spawn)
 *   events.jsonl        child's JSON event stream (child-written)
 *   stderr.log          child's stderr (child-written)
 *   exit                child's exit code (child-written; presence = done)
 *   settlement-<pass>.json
 *   relayed-<pass>      marker: settlement delivered to the conversation
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
  host?: string;
  dir?: string;
  worktree?: string | boolean;
  /** Model pattern passed to the child (`provider/id[:thinking]`). */
  model?: string;
  /** Wall-clock seconds before the child is killed and settled as timeout. */
  timeout: number;
  created_at: string;
  /** Unknown dispatch keys, preserved verbatim for accretion. */
  extra?: Record<string, unknown>;
}

export interface Settlement {
  id: string;
  pass: number;
  status: SettlementStatus;
  /** Human-readable cause for crashed/timeout/cancelled. */
  reason?: string;
  /** Verdict, ≤ RESULT_MAX chars. */
  result: string;
  artifacts?: string[];
  usage?: SubagentUsage;
  model?: string;
  settled_at: string;
}

const RESULT_MAX = 2000;
const POLL_MS = 2000;
const DEFAULT_TIMEOUT_S = Number(process.env.FAMILIAR_SUBAGENT_TIMEOUT) || 1800;
// Default child model ("provider/id", optional ":<thinking>" suffix — pi's
// --model pattern syntax). Unset = the child resolves pi's own default,
// which is typically the dispatcher's model; set this to keep drone work
// off the expensive frontier model.
const DEFAULT_MODEL = process.env.FAMILIAR_SUBAGENT_MODEL;

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(EXT_DIR);
const SPOOL = process.env.FAMILIAR_SUBAGENT_DIR || path.join(REPO, "state", "subagents");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "~", ".pi", "agent");
const SESSION_DIR = process.env.FAMILIAR_SUBAGENT_SESSION_DIR || path.join(AGENT_DIR, "subagent-sessions");

const VERDICT_FOOTER =
  "\n\n---\nYou are a dispatched subagent. Your final message is the only thing " +
  `returned to the dispatcher — a verdict, not a transcript (≤${RESULT_MAX} chars): ` +
  "what you did, what you concluded, what (if anything) failed. Write substantial " +
  "output to files and list their paths in the verdict.";

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

const mintId = (): string => {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const r = Math.random().toString(36).slice(2, 6);
  return `sub-${t}-${r}`;
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const killJob = (id: string) => {
  const pid = readPidSafe(jobDir(id));
  if (!pid || !pidAlive(pid)) return;
  try {
    process.kill(-pid, "SIGTERM"); // negative: the child leads its own process group
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
};

/* --- event stream → verdict ------------------------------------------------ */

// Walk the child's JSON event stream: last assistant text is the verdict,
// usage sums across assistant messages, a stopReason of "error" surfaces as
// a crash reason.
function harvest(id: string): { result: string; usage?: SubagentUsage; model?: string; error?: string } {
  let result = "";
  let model: string | undefined;
  let error: string | undefined;
  const usage: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  let sawUsage = false;

  let raw = "";
  try {
    raw = fs.readFileSync(path.join(jobDir(id), "events.jsonl"), "utf-8");
  } catch {
    return { result: "" };
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== "message_end" || ev.message?.role !== "assistant") continue;
    const msg = ev.message;
    const text = (Array.isArray(msg.content) ? msg.content : [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("");
    if (text.trim()) result = text;
    model = msg.model ?? model;
    if (msg.stopReason === "error") error = msg.errorMessage || "provider error";
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
  if (result.length > RESULT_MAX) result = result.slice(0, RESULT_MAX) + "…";
  return { result, usage: sawUsage ? usage : undefined, model, error };
}

/* --- settle + relay -------------------------------------------------------- */

// Idempotent: an existing settlement for (id, pass) wins; reprocessing is
// harmless (invariant). Returns the settlement on disk either way.
function settle(id: string, pass: number, partial: Pick<Settlement, "status" | "reason">): Settlement {
  const file = path.join(jobDir(id), `settlement-${pass}.json`);
  const existing = readJSON<Settlement>(file);
  if (existing) return existing;
  const { result, usage, model, error } = harvest(id);
  const settlement: Settlement = {
    id,
    pass,
    status: error && partial.status === "done" ? "crashed" : partial.status,
    reason: partial.reason ?? error,
    result,
    usage,
    model,
    settled_at: new Date().toISOString(),
  };
  writeJSON(file, settlement);
  return settlement;
}

export default function (pi: ExtensionAPI) {
  const pollers = new Map<string, ReturnType<typeof setInterval>>();

  // Idempotent via marker file. deliverAs steer + triggerTurn: lands after
  // the current turn if one is running, wakes the agent if idle. Returns
  // whether delivery is confirmed (marker on disk) — a throwing sendMessage
  // (e.g. mid-teardown) leaves no marker, and the caller keeps polling.
  const relay = (s: Settlement): boolean => {
    const marker = path.join(jobDir(s.id), `relayed-${s.pass}`);
    if (fs.existsSync(marker)) return true;
    const lines = [
      `<subagent-settlement id="${s.id}" pass="${s.pass}" status="${s.status}">`,
      ...(s.reason ? [`reason: ${s.reason}`] : []),
      s.result || "(no output)",
      ...(s.artifacts?.length ? [`artifacts: ${s.artifacts.join(", ")}`] : []),
      ...(s.usage
        ? [`usage: ${s.usage.input}in/${s.usage.output}out tokens, $${s.usage.cost.toFixed(4)}${s.model ? `, ${s.model}` : ""}`]
        : []),
      `</subagent-settlement>`,
    ];
    try {
      pi.sendMessage(
        { customType: "subagent-settlement", content: lines.join("\n"), display: true },
        { deliverAs: "steer", triggerTurn: true },
      );
    } catch {
      return false; // no marker — retried by the poller or the next session_start
    }
    fs.writeFileSync(marker, "");
    return true;
  };

  const stopPolling = (id: string) => {
    const t = pollers.get(id);
    if (t) clearInterval(t);
    pollers.delete(id);
  };

  // Watch a job for its child-written `exit` file (uniform for fresh spawns
  // and adopted orphans), enforce timeout, settle when it lands. The poller
  // stops only once the relay marker is on disk: settlement and delivery are
  // separate steps, and a failed relay retries every tick.
  const monitor = (id: string) => {
    if (pollers.has(id)) return;
    const dir = jobDir(id);
    const cmd = readJSON<DispatchCommand>(path.join(dir, "command.json"));
    if (!cmd) return;
    const deadline = Date.parse(cmd.created_at) + cmd.timeout * 1000;
    const tick = () => {
      const existing = readJSON<Settlement>(path.join(dir, `settlement-${cmd.pass}.json`));
      if (existing) {
        if (relay(existing)) stopPolling(id);
        return;
      }
      if (fs.existsSync(path.join(dir, "exit"))) {
        const code = Number(fs.readFileSync(path.join(dir, "exit"), "utf-8").trim() || "0");
        if (relay(settle(id, cmd.pass, code === 0
          ? { status: "done" }
          : { status: "crashed", reason: `exit code ${code}` }))) stopPolling(id);
        return;
      }
      if (Date.now() > deadline) {
        killJob(id);
        // The wrapper's exit file lands next tick; settle first so the
        // timeout verdict wins (settle is idempotent). Delivery falls to the
        // settled branch on subsequent ticks.
        relay(settle(id, cmd.pass, { status: "timeout", reason: `exceeded ${cmd.timeout}s` }));
      }
    };
    pollers.set(id, setInterval(tick, POLL_MS));
  };

  /* --- tools --------------------------------------------------------------- */

  pi.registerTool({
    name: "dispatch",
    label: "Dispatch Subagent",
    description:
      "Dispatch work to an async subagent (a headless pi process). Returns { ok, id, pass } immediately; " +
      "the settlement (verdict ≤2k chars, token/dollar usage) is relayed into the conversation when the work " +
      "lands. Use for anything expected to take >10 seconds. The child starts cold: include all needed " +
      "context in the prompt. It has file tools, bash, and web search/fetch — no identity, no history.",
    promptSnippet: "Dispatch async work to a subagent; settlement relays back on completion",
    parameters: Type.Object({
      prompt: Type.String({ description: "Complete task description — the child has no other context" }),
      dir: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
      worktree: Type.Optional(Type.Boolean({ description: "Run in a detached git worktree of dir (isolates edits)" })),
      model: Type.Optional(Type.String({ description: `Model for the child as provider/id, e.g. "anthropic/claude-haiku-4-5" (default: ${DEFAULT_MODEL || "pi's default model"}). Use a cheap model for mechanical work.` })),
      host: Type.Optional(Type.String({ description: "Reserved: remote dispatch target (unsupported on the floor)" })),
      timeout: Type.Optional(Type.Integer({ description: `Seconds before kill+timeout settle (default ${DEFAULT_TIMEOUT_S})` })),
    }),
    async execute(_toolCallId, params: Record<string, any>) {
      const { prompt, dir, worktree, host, timeout, model, ...extra } = params;
      if (host) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "remote dispatch is not supported yet (FAMILIAR_HERDR_CLUSTERS ceiling)" }) }], isError: true };
      }

      const id = mintId();
      const pass = 1;
      const dirPath = jobDir(id);
      let cwd = path.resolve(dir || process.cwd());

      const command: DispatchCommand = {
        id,
        pass,
        prompt,
        dir: cwd,
        worktree,
        model: model || DEFAULT_MODEL,
        timeout: timeout || DEFAULT_TIMEOUT_S,
        created_at: new Date().toISOString(),
        ...(Object.keys(extra).length ? { extra } : {}),
      };
      // Durable before side effects.
      writeJSON(path.join(dirPath, "command.json"), command);

      try {
        if (worktree) {
          const wt = path.join(dirPath, "worktree");
          execFileSync("git", ["-C", cwd, "worktree", "add", "--detach", wt], { stdio: "pipe" });
          cwd = wt;
        }

        fs.mkdirSync(SESSION_DIR, { recursive: true });
        const args = [
          "--mode", "json",
          "--no-extensions",
          "-e", path.join(EXT_DIR, "anthropic-gateway.ts"),
          "-e", path.join(EXT_DIR, "web.ts"),
          "--no-skills",
          "--no-context-files",
          "--session-dir", SESSION_DIR,
          ...(command.model ? ["--model", command.model] : []),
          "-p", // prompt rides FAMILIAR_SUBAGENT_PROMPT to dodge quoting
        ];
        // The child owns its output files (doorbell invariant: invoker death
        // is harmless), leads its own process group (killable as a tree),
        // and records its own exit code.
        const script =
          `pi ${args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")} "$FAMILIAR_SUBAGENT_PROMPT" ` +
          `> "$FAMILIAR_SUBAGENT_JOB/events.jsonl" 2> "$FAMILIAR_SUBAGENT_JOB/stderr.log"; ` +
          `echo $? > "$FAMILIAR_SUBAGENT_JOB/exit"`;
        const child = spawn("bash", ["-c", script], {
          cwd,
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            FAMILIAR_SUBAGENT_PROMPT: prompt + VERDICT_FOOTER,
            FAMILIAR_SUBAGENT_JOB: dirPath,
          },
        });
        child.unref();
        fs.writeFileSync(path.join(dirPath, "pid"), String(child.pid));
        monitor(id);

        return { content: [{ type: "text", text: JSON.stringify({ ok: true, id, pass }) }] };
      } catch (e: any) {
        // The tool result IS the relay (as in cancel): settle for the record,
        // mark delivered, don't double-deliver via steer.
        settle(id, pass, { status: "crashed", reason: `dispatch failed: ${e?.message ?? e}` });
        fs.writeFileSync(path.join(dirPath, `relayed-${pass}`), "");
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, id, pass, error: String(e?.message ?? e) }) }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent Status",
    description: "List dispatched subagents and their status (running or settled). Optionally filter by id.",
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
        const s = readJSON<Settlement>(path.join(jobDir(id), `settlement-${cmd.pass}.json`));
        return {
          id,
          pass: cmd.pass,
          status: s?.status ?? "running",
          created_at: cmd.created_at,
          ...(s ? { settled_at: s.settled_at, usage: s.usage } : {}),
          prompt: cmd.prompt.length > 120 ? cmd.prompt.slice(0, 120) + "…" : cmd.prompt,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagent",
    description: "Cancel a running subagent by id. Kills the child process tree and settles the job as cancelled.",
    promptSnippet: "Cancel a running subagent",
    parameters: Type.Object({
      id: Type.String({ description: "Job id from dispatch" }),
    }),
    async execute(_toolCallId, params: { id: string }) {
      const cmd = readJSON<DispatchCommand>(path.join(jobDir(params.id), "command.json"));
      if (!cmd) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "unknown id" }) }], isError: true };
      }
      const already = readJSON<Settlement>(path.join(jobDir(params.id), `settlement-${cmd.pass}.json`));
      if (already) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, id: params.id, pass: cmd.pass, status: already.status, note: "already settled" }) }] };
      }
      killJob(params.id);
      const s = settle(params.id, cmd.pass, { status: "cancelled", reason: "cancelled by dispatcher" });
      stopPolling(params.id);
      const marker = path.join(jobDir(params.id), `relayed-${cmd.pass}`);
      fs.writeFileSync(marker, ""); // the tool result IS the relay; don't double-deliver
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, id: s.id, pass: s.pass, status: s.status }) }] };
    },
  });

  /* --- reconciliation ------------------------------------------------------ */

  // Doorbell invariant, receiving side: children outlive their invoker, so a
  // fresh session adopts the spool — relay unrelayed settlements, settle
  // finished-but-unsettled jobs, resume monitoring live ones, and declare
  // the truly lost crashed.
  pi.on("session_start", async () => {
    if (!fs.existsSync(SPOOL)) return;
    for (const id of fs.readdirSync(SPOOL)) {
      const dir = jobDir(id);
      const cmd = readJSON<DispatchCommand>(path.join(dir, "command.json"));
      if (!cmd) continue;
      const settlement = readJSON<Settlement>(path.join(dir, `settlement-${cmd.pass}.json`));
      if (settlement) {
        // no-op when the marker exists; a failed relay falls to the poller
        if (!relay(settlement)) monitor(id);
        continue;
      }
      if (fs.existsSync(path.join(dir, "exit"))) {
        monitor(id); // first tick settles from the exit file
        continue;
      }
      const pid = readPidSafe(dir);
      if (pid && pidAlive(pid)) {
        monitor(id);
      } else {
        const s = settle(id, cmd.pass, { status: "crashed", reason: "process lost (invoker restarted, child not found)" });
        if (!relay(s)) monitor(id);
      }
    }
  });

  pi.on("session_shutdown", async () => {
    for (const id of [...pollers.keys()]) stopPolling(id);
    // Children keep running by design; the next session adopts them.
  });
}

const readPidSafe = (dir: string): number => {
  try {
    return Number(fs.readFileSync(path.join(dir, "pid"), "utf-8").trim());
  } catch {
    return 0;
  }
};
