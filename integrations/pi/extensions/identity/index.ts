import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorLog } from "../lib/debug.ts";
import { impGuidance, stuffGuidance } from "./guidance.ts";
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
      return { systemPrompt: await buildPrompt(event) };
    } catch (err) {
      errorLog("identity", { promptBuildFailed: String(err), degraded: lastGood ? "last-good" : "pi-default" });
      return lastGood ? { systemPrompt: lastGood } : undefined;
    }
  });

  const buildPrompt = async (event: BeforeAgentStartEvent): Promise<string | undefined> => {
    const identityDir = process.env.FAMILIAR_IDENTITY_PATH;
    if (!identityDir) return undefined;

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

    // Context files may carry sensitive project instructions: they are
    // assembled into the prompt and never logged.
    const systemPrompt = assembleSystemPrompt({
      identity,
      options: event.systemPromptOptions,
      impGuidance: impGuidance(),
      stuffGuidance: stuffGuidance(),
    });

    // Only cache a prompt that actually carries identity: an empty or
    // unreadable identity dir would otherwise poison the fallback with a
    // scaffolding-only prompt and make the degradation permanent.
    if (identity) lastGood = systemPrompt;
    return systemPrompt;
  };
}
