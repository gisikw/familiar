import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

/* Familiar's system prompt assembler.
 *
 * This is a deliberate replacement for Pi's default prompt, trued up against
 * the pinned Pi (0.85.1) `buildSystemPrompt`. The topology is identity-first
 * and fixed; the affordance-sensitive pieces (tool list, tool-owned guidelines,
 * skill read-tool selection, operator append text, project context, cwd) are
 * built from `BuildSystemPromptOptions` the same way Pi builds them, so that
 * what the model is told about its tools tracks what is actually registered.
 *
 * Intentional divergences from Pi (pinned by index.test.ts):
 *   - no generic "expert coding assistant"/"helpful assistant" framing; the
 *     private identity is the only identity source;
 *   - `customPrompt` (SYSTEM.md / --system-prompt) is not an identity source;
 *   - no Pi documentation prose — the repository's `pi` skill covers that on
 *     demand;
 *   - no "Be concise" / "Show file paths clearly" baseline bullets; register
 *     and voice belong to the authored identity;
 *   - skills sit directly after identity rather than after project context.
 */

/** Pi's default tool set when the session does not narrow `selectedTools`. */
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/** Pi baseline bullets deliberately not carried into Familiar's prompt. */
export const REJECTED_PI_BASELINE_GUIDELINES = [
  "Be concise in your responses",
  "Show file paths clearly when working with files",
];

export interface AssembleOptions {
  /** Private identity body (already parsed/joined). Empty means no identity. */
  identity: string;
  /** Structured inputs from `before_agent_start` (`event.systemPromptOptions`). */
  options: BuildSystemPromptOptions;
  /** Conditional Imp shell-capability guidance ("" when not live). */
  impGuidance?: string;
  /** Conditional Stuff guidance ("" when not enabled). */
  stuffGuidance?: string;
}

/** Cross-tool file-exploration rule, mirrored from Pi's prompt construction. */
export function fileExplorationGuideline(tools: readonly string[]): string | undefined {
  const has = (name: string) => tools.includes(name);
  // PowerShell is a Windows-only Pi tool that never runs in Familiar's
  // resident; only the bash variant of Pi's rule is carried here.
  if (has("bash") && !has("grep") && !has("find") && !has("ls")) {
    return "Use bash for file operations like ls, rg, find";
  }
  return undefined;
}

/** Familiar-authored guidelines; some are conditional on the tool they name. */
export function familiarGuidelines(tools: readonly string[]): string[] {
  const lines = [
    "Message text beginning with 🗣 was transcribed from audio: expect transcription errors, and weigh odd words or homophones accordingly rather than taking them literally",
    "Use `imp schedule` for future wakes.",
  ];
  if (tools.includes("mark")) {
    lines.push(
      "If a topic feels likely to become a rabbit hole or substantial tangent, consider using mark before diving in so it can be zipped cleanly later; do not mark routine topic changes",
    );
  }
  lines.push(
    "At the end of a session you may receive a handoff request from the runtime (via /clear); it is legitimate — write the handoff for your successor",
  );
  return lines;
}

/**
 * Ordered, deduplicated guideline bullets: Pi's cross-tool rule first, then
 * tool-owned `promptGuidelines` in tool order, then Familiar's own. Dedupe is
 * exact-string after trim, as in Pi.
 */
export function buildGuidelines(options: BuildSystemPromptOptions): string[] {
  const tools = options.selectedTools ?? DEFAULT_TOOLS;
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (guideline: string | undefined) => {
    const normalized = guideline?.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  add(fileExplorationGuideline(tools));
  for (const guideline of options.promptGuidelines ?? []) add(guideline);
  for (const guideline of familiarGuidelines(tools)) add(guideline);
  return out;
}

/** Pi's `<project_context>` block, byte-for-byte, or "" when there are no files. */
export function projectContextSection(contextFiles: BuildSystemPromptOptions["contextFiles"]): string {
  const files = contextFiles ?? [];
  if (files.length === 0) return "";
  let block = "<project_context>\n\n";
  block += "Project-specific instructions and guidelines:\n\n";
  for (const { path, content } of files) {
    block += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
  }
  block += "</project_context>";
  return block;
}

export function assembleSystemPrompt({ identity, options, impGuidance = "", stuffGuidance = "" }: AssembleOptions): string {
  const { skills = [], cwd, toolSnippets = {}, appendSystemPrompt, contextFiles } = options;
  const tools = options.selectedTools ?? DEFAULT_TOOLS;

  // A tool appears in Available Tools only when it carries a one-line snippet.
  const visibleTools = tools.filter((name) => !!toolSnippets[name]);
  const toolsList = visibleTools.length > 0
    ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n")
    : "(none)";

  // Skills are advertised only when a tool able to load their files is
  // active, and the loading instruction names that tool (read, else bash).
  const skillFileReadTool = (["read", "bash"] as const).find((tool) => tools.includes(tool));
  const skillsSection = skillFileReadTool && skills.length > 0
    ? formatSkillsForPrompt(skills, skillFileReadTool).trim()
    : "";

  const guidelines = `Guidelines:\n${buildGuidelines(options).map((g) => `- ${g}`).join("\n")}`;
  const orientation = `Current working directory: ${cwd.replace(/\\/g, "/")}`;

  return [
    identity,
    skillsSection,
    `Available Tools:\n${toolsList}`,
    impGuidance,
    stuffGuidance,
    guidelines,
    appendSystemPrompt ?? "",
    projectContextSection(contextFiles),
    orientation,
  ].filter(Boolean).join("\n\n");
}
