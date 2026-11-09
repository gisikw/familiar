import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorLog } from "../lib/debug.ts";
import { readSystemText, writeSystemText } from "../lib/system-payload.ts";
import { impGuidance } from "./guidance.ts";
import { assembleSystemPrompt } from "./prompt.ts";

// Familiar replaces Pi's system prompt outright rather than chaining onto
// `event.systemPrompt`: the private identity is the only identity source, and
// Pi's generic framing ("expert coding assistant") must never precede it. The
// structured `event.systemPromptOptions` remain the source of truth for what
// the model is told about tools, skills, operator append text and project
// context — see prompt.ts. Consequences, pinned in index.test.ts:
//   - earlier before_agent_start handlers' prompt text is intentionally not
//     carried forward (no resident extension modifies the prompt before
//     identity; anything that must reach the model should ride
//     systemPromptOptions or a returned message instead);
//   - later handlers still receive and may extend the identity prompt.
export default function(pi: ExtensionAPI) {
  // Last successfully built prompt. This handler runs before *every* turn and
  // reassembles identity from disk each time — which is what lets identity
  // edits take effect live, and also what puts a filesystem read, an env var,
  // and an `age` subprocess on the critical path of every response. A single
  // transient failure (key rotated, perms changed, spawn hiccup under load)
  // would otherwise throw into pi's turn setup and leave the agent unable to
  // answer at all, with nothing explaining why. Degrade instead: keep the last
  // known-good prompt, and fall through to pi's own default if we never had
  // one. Waking diminished beats not waking.
  let lastGood: string | undefined;

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      return { systemPrompt: await buildPrompt(event.systemPromptOptions) };
    } catch (err) {
      errorLog("identity", { promptBuildFailed: String(err), degraded: lastGood ? "last-good" : "pi-default" });
      return lastGood ? { systemPrompt: lastGood } : undefined;
    }
  });

  // Pi 0.86+ applies a returned `systemPrompt` (`forceSystemPrompt`) only to
  // runs started by prompt(); runs started any other way — sendMessage with
  // triggerTurn (scheduler wakes, Imp attention, handoff orientation) — never
  // emit before_agent_start and would reach the provider with Pi's generic
  // default prompt. Pi 0.85.1 instead kept the last identity prompt in agent
  // state. Re-impose identity on every request the same way Pi's own forced
  // projection does: one leading system message holding the prompt and the
  // currently declared tools, all other system messages dropped. For
  // prompt() runs Pi's projection runs after this with identical text.
  pi.on("context_with_system", async (event, ctx) => {
    if (!event.messages.some((message) => message.role === "system")) return undefined;
    let prompt: string | undefined;
    try {
      prompt = await buildPrompt(ctx.getSystemPromptOptions());
    } catch (err) {
      errorLog("identity", { promptBuildFailed: String(err), degraded: lastGood ? "last-good" : "pi-default", event: "context_with_system" });
      prompt = lastGood;
    }
    if (prompt === undefined) return undefined;
    return { messages: projectIdentityPrompt(event.messages, prompt) };
  });

  // Last line of defense, kept from 0.85.1 (the context_with_system projection
  // above is the primary path on Pi 1.x). before_agent_start only runs for
  // prompt()-initiated runs. Pi 0.85.1 starts
  // turns from `sendMessage(..., { triggerTurn: true })` (scheduler wakes,
  // restart notices, imp merges, handoff) without it, and its next-turn refresh
  // inside every run rebuilds the system prompt as `override ?? base`, where the
  // override is cleared when each run settles. So a woken run's first request
  // carried whatever was left in agent state (Pi's generic prompt right after a
  // boot) and every request after a tool call carried Pi's generic "expert
  // coding assistant" prompt. Verified in tiamat-router captures, Oct 3 2026.
  //
  // Guard at the wire, where it can't be bypassed: if Pi's generic framing is
  // about to leave, send identity instead — the last assembled prompt when we
  // have one, else identity spliced over Pi's framing (right after a boot,
  // before any prompt()-run has handed us systemPromptOptions). Prompts that
  // aren't Pi's default (ours, compaction's summarizer, anyone else's) pass
  // through untouched.
  pi.on("before_provider_request", async (event) => {
    const current = readSystemText(event.payload);
    if (current === undefined || !isPiDefaultPrompt(current)) return undefined;
    try {
      const replacement = lastGood ?? spliceIdentity(await readIdentity(), current, impGuidance());
      if (!replacement) return undefined;
      errorLog("identity", { wireGuard: lastGood ? "last-good" : "spliced" });
      return writeSystemText(event.payload, replacement);
    } catch (err) {
      errorLog("identity", { wireGuardFailed: String(err) });
      return undefined;
    }
  });

  const readIdentity = async (): Promise<string> => {
    const identityDir = process.env.FAMILIAR_IDENTITY_PATH;
    if (!identityDir) return "";

    // Identity is ordinary markdown in the private instance. Binary voices
    // live in the sibling voices tree and are never loaded into this prompt.
    const files = (await readdir(identityDir)).sort().filter(f => f.endsWith(".md"));
    const bodies = await Promise.all(files.map(f => readFile(join(identityDir, f), "utf-8")));
    const identity = bodies
      .map(body => {
        const m = body.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        if (!m) return body.trim();
        const meta = Object.fromEntries(
          m[1].split("\n").filter(Boolean)
            .map(line => line.split(":"))
            .map(([k, ...v]) => [k.trim(), v.join(":").trim()])
        );
        return meta.disabled === "true" ? "" : m[2].trim();
      })
      .filter(Boolean)
      .join("\n\n");
    return identity;
  };

  const buildPrompt = async (options: BuildSystemPromptOptions): Promise<string | undefined> => {
    if (!process.env.FAMILIAR_IDENTITY_PATH) return undefined;
    const identity = await readIdentity();

    // Context files may carry sensitive project instructions: they are
    // assembled into the prompt and never logged.
    const systemPrompt = assembleSystemPrompt({
      identity,
      options,
      impGuidance: impGuidance(),
    });

    // Only cache a prompt that actually carries identity: an empty or
    // unreadable identity dir would otherwise poison the fallback with a
    // scaffolding-only prompt and make the degradation permanent.
    if (identity) lastGood = systemPrompt;
    return systemPrompt;
  };
}

/**
 * Pi's built-in default prompt opens with one of these framings; Familiar's
 * never does. 0.85.1 through 1.1.0 used the first; 1.5.0 reworded it.
 */
export const PI_DEFAULT_OPENINGS = [
  "You are an expert coding assistant operating inside pi",
  "You are a coding assistant running inside pi",
] as const;
/** The opening the pinned Pi emits today. */
export const PI_DEFAULT_OPENING = PI_DEFAULT_OPENINGS[PI_DEFAULT_OPENINGS.length - 1];

export function isPiDefaultPrompt(text: string): boolean {
  const head = text.trimStart();
  return PI_DEFAULT_OPENINGS.some((opening) => head.startsWith(opening));
}

/**
 * Degraded identity prompt for the window before any prompt()-run: identity
 * (and live Imp guidance) replaces Pi's generic opening paragraph; Pi's own
 * tool list, guidelines, context files and cwd are kept as they were rendered.
 * Returns undefined when there is no identity to splice in.
 */
export function spliceIdentity(identity: string, piPrompt: string, impGuidanceText = ""): string | undefined {
  if (!identity) return undefined;
  const trimmed = piPrompt.trimStart();
  const firstBreak = trimmed.indexOf("\n\n");
  const rest = firstBreak >= 0 ? trimmed.slice(firstBreak + 2) : "";
  return [identity, impGuidanceText, rest].filter(Boolean).join("\n\n");
}

type TranscriptTool = { name: string };
type TranscriptSystemMessage = {
  role: "system";
  timestamp?: number;
  toolsAdded?: TranscriptTool[];
  toolsRemoved?: TranscriptTool[];
};

/**
 * Mirror of Pi 1.0's forced-prompt projection (AgentSession
 * `_installAgentForcedPromptProjection`): collapse every system message into
 * one leading message carrying `prompt` and the current tool declarations,
 * replayed like pi-ai's `getCurrentTools` (removals, then additions, in order).
 */
export function projectIdentityPrompt<M extends { role: string }>(messages: readonly M[], prompt: string): M[] {
  const tools = new Map<string, TranscriptTool>();
  let timestamp: number | undefined;
  for (const message of messages) {
    if (message.role !== "system") continue;
    const system = message as unknown as TranscriptSystemMessage;
    timestamp ??= system.timestamp;
    for (const tool of system.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of system.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  const head = {
    role: "system",
    content: prompt,
    ...(tools.size > 0 ? { toolsAdded: [...tools.values()] } : {}),
    timestamp: timestamp ?? Date.now(),
  } as unknown as M;
  return [head, ...messages.filter((message) => message.role !== "system")];
}
