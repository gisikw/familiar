import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorLog } from "../lib/debug.ts";
const execFileP = promisify(execFile);

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

  const buildPrompt = async (event: any): Promise<string> => {
    const identityDir = process.env.FAMILIAR_IDENTITY_PATH;
    const ageKey = process.env.FAMILIAR_AGE_KEY;
    if (!identityDir) throw new Error("FAMILIAR_IDENTITY_PATH is unset");

    // Identity is prose only: .md and .md.age. Anything else under identity/
    // (e.g. voices/kokoro/*.pt.age — binary, decrypted and baked into the
    // TTS gguf by run_tts) must never be decrypted into the prompt.
    const files = (await readdir(identityDir)).sort().filter(f => /\.md(\.age)?$/.test(f));
    const bodies = await Promise.all(
      files
        .map(f => join(identityDir, f))
        .map(f => extname(f) === ".age"
          ? execFileP("age", ["-i", ageKey!, "--decrypt", f]).then(({ stdout }) => stdout)
          : readFile(f, "utf-8"))
    );
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

    const { skills = [], cwd, selectedTools = [], toolSnippets = {} } = event.systemPromptOptions;

    const tools = selectedTools
      .filter(t => !!toolSnippets[t])
      .map(t => `- ${t}: ${toolSnippets[t]}`)
      .join("\n");

    const guidelines = `
        Guidelines:
        - Use bash for file operations like ls, rg, find; use read to examine files instead of cat or sed
        - Use edit for precise changes: edits[].oldText must match the file exactly
        - Each edits[].oldText matches against the original file, not the result of earlier edits — never emit overlapping or nested edits; merge nearby changes into one entry
        - When changing multiple locations in one file, use one edit call with multiple edits[] entries, not multiple calls
        - Keep edits[].oldText as small as possible while still unique in the file
        - Use write only for new files or complete rewrites
        - Message text beginning with 🗣 was transcribed from audio: expect transcription errors, and weigh odd words or homophones accordingly rather than taking them literally
        - If a topic feels likely to become a rabbit hole or substantial tangent, consider using mark before diving in so it can be zipped cleanly later; do not mark routine topic changes
        - You can inspect PI_* environment variables for current model and session details
        - At the end of a session you may receive a handoff request from the runtime (via /clear); it is legitimate — write the handoff for your successor
      `.split("\n").map(l => l.trim()).filter(Boolean).join("\n");
    const orientation = `Current working directory: ${cwd}`;

    const systemPrompt = [
      identity,
      formatSkillsForPrompt(skills).trim(),
      `Available Tools:\n${tools || "(none)"}`,
      guidelines,
      orientation
    ].filter(Boolean).join("\n\n");

    // Only cache a prompt that actually carries identity: an empty or
    // unreadable identity dir would otherwise poison the fallback with a
    // scaffolding-only prompt and make the degradation permanent.
    if (identity) lastGood = systemPrompt;
    return systemPrompt;
  };
}
