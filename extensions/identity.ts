import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import fs from "fs";

export default function(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const identity = "You're Terry the Test Agent";

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
      - You can inspect PI_* environment variables for current model and session details
    `.split("\n").map(l => l.trim()).filter(Boolean).join("\n");
    const orientation = `Current working directory: ${cwd}`;

    const systemPrompt = [
      identity,
      formatSkillsForPrompt(skills).trim(),
      `Available Tools:\n${tools || "(none)"}`,
      guidelines,
      orientation
    ].filter(Boolean).join("\n\n");

    return { systemPrompt };
  });
}
