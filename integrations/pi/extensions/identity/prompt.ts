import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

/* Familiar's system prompt assembler.
 *
 * This is a deliberate replacement for Pi's default prompt, trued up against
 * the pinned Pi (1.0.0) `buildSystemPrompt`. The topology is identity-first
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
 *   - skills sit directly after identity rather than after project context;
 *   - Pi 0.86+ renders its default prompt as XML-tagged transcript sections
 *     (`<tools>`, `<rules>`, `<addendum>`, `<cwd>`, ...). Familiar keeps
 *     its own headings and raw operator append bytes; only the
 *     `<project_context>` block and extension `sections` reuse Pi's bytes.
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
 * Ordered, deduplicated guideline bullets, as Pi's `<rules>` section orders
 * them: Pi's cross-tool rule first, then tool-owned guidelines in selected-tool
 * order (Pi 0.86+ passes these per tool as `toolGuidelines`; earlier Pi
 * flattened them into `promptGuidelines`), then any remaining
 * `promptGuidelines`, then Familiar's own. Dedupe is exact-string after trim,
 * as in Pi.
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
  const toolGuidelines = options.toolGuidelines ?? {};
  for (const name of tools) for (const guideline of toolGuidelines[name] ?? []) add(guideline);
  for (const guideline of options.promptGuidelines ?? []) add(guideline);
  for (const guideline of familiarGuidelines(tools)) add(guideline);
  return out;
}

/** Pi's `<project_context>` section, byte-for-byte, or "" when there are no files. */
export function projectContextSection(contextFiles: BuildSystemPromptOptions["contextFiles"]): string {
  const files = contextFiles ?? [];
  if (files.length === 0) return "";
  const body = [
    "Project-specific instructions and guidelines:",
    ...files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
  ].join("\n\n");
  return `<project_context>\n${body}\n</project_context>`;
}

/**
 * Extension-supplied `sections` (Pi 0.86+), rendered as Pi renders them after
 * cwd: `<name>\ncontent\n</name>`, empty content omitted. Nothing resident
 * sets these today (the built-in mcp extension that would is disabled), but a
 * replacement prompt must not silently drop them.
 */
export function customSections(sections: BuildSystemPromptOptions["sections"]): string[] {
  return Object.entries(sections ?? {})
    .filter(([, content]) => !!content)
    .map(([name, content]) => `<${name}>\n${content}\n</${name}>`);
}

export function assembleSystemPrompt({ identity, options, impGuidance = "" }: AssembleOptions): string {
  const { skills = [], cwd, toolSnippets = {}, appendSystemPrompt, contextFiles, sections } = options;
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
    guidelines,
    appendSystemPrompt ?? "",
    projectContextSection(contextFiles),
    orientation,
    ...customSections(sections),
  ].filter(Boolean).join("\n\n");
}
