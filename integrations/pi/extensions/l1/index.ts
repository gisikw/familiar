import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorLog } from "../lib/debug.ts";
import { completeHandoff, handoffMaxTokens } from "../handoff/request.ts";

// L1 fast memory (packages/l1). Off unless [familiar] l1_enabled = true.
//
//   cue      before each human turn: entities first-mentioned this session get
//            one hidden gloss line each (at most three), from the l1 store.
//   intake   at a handoff, a separate model call over the same context (cache
//            hit) nominates up to five facts; l1 vets them with the local
//            decider before admission. Not coupled to the subconscious seeds.
//   revise   after the handoff lands: l1 revises facts for entities Kev
//            mentioned, using only his words; then decays to target; then
//            applies Kev's answers to earlier asks. Unsure changes wait in
//            l1's pending table; the curator stages them (`l1 asks --post`).
//
// Nothing here can block a turn or a handoff: every l1 call is bounded or
// detached, and failures are logged and dropped.

export const L1_MESSAGE = "l1-gloss";
const CUE_TIMEOUT_MS = 1500;
const INTAKE_TIMEOUT_MS = 60_000;

export function l1Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FAMILIAR_L1_ENABLED === "true";
}

export function l1Bin(env: NodeJS.ProcessEnv = process.env): string {
  return env.FAMILIAR_L1_BIN ? join(env.FAMILIAR_L1_BIN, "l1") : "l1";
}

export function renderGloss(lines: string[]): string {
  return `<system-reminder>From L1 memory (first mention this session; may be stale):\n${lines.map((l) => `- ${l}`).join("\n")}</system-reminder>`;
}

/** Run l1 with stdin, bounded. Resolves stdout ("" on any failure). */
export function runL1(args: string[], input: string, timeoutMs: number, bin = l1Bin()): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try {
      child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      errorLog("l1", { spawnFailed: String(err) });
      return finish("");
    }
    const timer = setTimeout(() => { child.kill("SIGKILL"); errorLog("l1", { timeout: args[0] }); finish(""); }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => errorLog("l1", { stderr: d.toString().slice(0, 500) }));
    child.on("error", (err: Error) => { errorLog("l1", { error: String(err) }); finish(""); });
    child.on("close", (code: number) => finish(code === 0 ? out : ""));
    child.stdin.end(input);
  });
}

/** Fire-and-forget a shell pipeline of l1 steps (survives nothing but needs nothing). */
function detached(script: string) {
  try {
    const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (err) {
    errorLog("l1", { detachFailed: String(err) });
  }
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const INTAKE_PROMPT = `[L1 intake — private, not a reply to anyone]
You are about to lose this context. L1 is your small fast memory: typed facts that get glossed to you the first time an entity comes up in a future session. Nominate up to five facts you'd most want a future you to know, that aren't already obvious and are about people, orgs, places, works or projects in Kevin's life.

Rules:
- Only facts Kevin said himself, or that a primary document in this context states. Not your own inferences.
- Attributes are a closed set: relation, role, employer, former_employer, location, age, born, author, status, origin, link. If it doesn't fit, skip it.
- kind is one of: person, org, place, work, project, concept, other.
- Values short (under 80 chars). Aliases: other names he uses for it (lowercase).
- No sensitive personal history; no work-confidential portfolio-company detail.

Reply with exactly one JSON object and nothing else:
{"nominations":[{"entity":"…","kind":"…","aliases":["…"],"attr":"…","value":"…"}]}
Zero nominations is fine: {"nominations":[]}`;

export function parseNominations(text: string): unknown[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(v?.nominations) ? v.nominations.slice(0, 5) : null;
  } catch {
    return null;
  }
}

/**
 * The cue scope: "first mention" means first since my context last started
 * over. Presence keeps one session ID forever and compacts in place, so the
 * session ID alone would mean "first mention ever". Scope it to the latest
 * compaction on the current branch (handoff clears and zips both write one);
 * derived from the session file, so it survives restarts.
 */
export function cueScope(session: string, branch: readonly any[] | undefined): string {
  if (branch) {
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      if (e?.type === "compaction" && typeof e.id === "string" && e.id) return `${session}@${e.id}`;
    }
  }
  return session;
}

export default function(pi: ExtensionAPI) {
  if (!l1Enabled()) return;
  let pendingText: string | null = null;

  pi.on("input", async (event) => {
    pendingText = typeof event.text === "string" ? event.text : null;
    return { action: "continue" as const };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const text = pendingText;
    pendingText = null;
    if (!text) return;
    const session = ctx.sessionManager.getSessionId();
    if (!session) return;
    let branch: readonly any[] | undefined;
    try { branch = ctx.sessionManager.getBranch?.() as any[]; } catch { branch = undefined; }
    const out = await runL1(["cue", "--session", cueScope(session, branch)], text, CUE_TIMEOUT_MS);
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3);
    if (!lines.length) return;
    return { message: { customType: L1_MESSAGE, content: renderGloss(lines), display: false } };
  });

  // Intake: a separate call over the outgoing context, in parallel with the
  // handoff (same prefix, so the cache is warm). Never awaited by compaction.
  pi.on("session_before_compact", async (event, ctx) => {
    if (event.willRetry || !ctx.model) return;
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return;
    const model = ctx.model;
    const sessionId = ctx.sessionManager.getSessionId();
    // Lazy: keeps the cue path (and its tests) free of the Pi runtime import.
    const { buildSessionContext, convertToLlm } = await import("@earendil-works/pi-coding-agent");
    const messages = convertToLlm(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages);
    messages.push({ role: "user", content: [{ type: "text", text: INTAKE_PROMPT }], timestamp: Date.now() } as any);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INTAKE_TIMEOUT_MS);
    void (async () => {
      try {
        const response: any = await completeHandoff((reasoning) => ctx.modelRegistry.complete(
          model,
          { systemPrompt: ctx.getSystemPrompt(), messages },
          {
            signal: controller.signal,
            cacheRetention: "short",
            ...(reasoning === undefined ? {} : { reasoningEffort: reasoning }),
            ...(sessionId ? { sessionId } : {}),
            ...(handoffMaxTokens(model.provider, 1024) === undefined ? {} : { maxTokens: 1024 }),
          },
        ) as any, controller.signal);
        const text = (response?.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("");
        const noms = parseNominations(text);
        if (!noms) { errorLog("l1", { intake: "unparseable" }); return; }
        if (!noms.length) return;
        const dir = mkdtempSync(join(tmpdir(), "l1-intake-"));
        const path = join(dir, "nominations.json");
        writeFileSync(path, JSON.stringify(noms), { mode: 0o600 });
        const bin = sq(l1Bin());
        detached(`${bin} nominate --session-file ${sq(file)} --since 72h < ${sq(path)}; ${bin} asks; rm -rf ${sq(dir)}`);
      } catch (err) {
        errorLog("l1", { intakeFailed: String(err) });
      } finally {
        clearTimeout(timer);
      }
    })();
  });

  // Revision after the handoff lands: Kev's words since the last revision.
  pi.on("session_compact", async (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return;
    const bin = sq(l1Bin());
    const target = Number(process.env.FAMILIAR_L1_TARGET) || 150;
    detached(`${bin} revise --session-file ${sq(file)}; ${bin} decay --target ${target}; ${bin} asks`);
  });
}
