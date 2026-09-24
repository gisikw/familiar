import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { impGuidance, stuffGuidance } from "./guidance.ts";

/* Familiar's prompt assembler is a deliberate replacement for Pi's, trued up
 * against the pinned Pi (0.85.1) `buildSystemPrompt`. These tests exercise the
 * actual assembled output through the extension handler and pin:
 *   - identity-first topology and the intentional omissions (no generic
 *     assistant framing, no Pi docs prose, no baseline style bullets);
 *   - the parity-owned affordances copied from Pi's construction: tool
 *     visibility, tool-owned promptGuidelines (order + dedupe), skills with
 *     read-or-bash loading, appendSystemPrompt, <project_context>, cwd.
 *
 * Upgrade checklist (on a Pi bump):
 *   1. Diff dist/core/system-prompt.js and formatSkillsForPrompt in
 *      dist/core/skills.js against the previous pin.
 *   2. Run this file in the agents dev shell; the "parity with pinned Pi"
 *      block runs Pi's real buildSystemPrompt and compares structural
 *      affordances, so guideline/skills/context-file drift fails here.
 *   3. Classify each new delta (identity divergence / affordance / irrelevant
 *      / dilution) in prompt.ts before adopting it. Never import Pi's generic
 *      framing or documentation prose.
 * No private identity content appears here: fixtures use synthetic markdown.
 */

const piPackageDir = process.env.PI_PACKAGE_DIR;
if (!piPackageDir) throw new Error("PI_PACKAGE_DIR is required (run in Familiar's pi or agents dev shell)");
const realCodingAgent = await import(join(piPackageDir, "dist/index.js"));
// Bun mocks are process-global; keep every real export so the canonical suite
// still exercises Pi's real modules after this file runs.
mock.module("@earendil-works/pi-coding-agent", () => ({ ...realCodingAgent }));
const { buildSystemPrompt } = await import(join(piPackageDir, "dist/core/system-prompt.js"));

const { assembleSystemPrompt, buildGuidelines, REJECTED_PI_BASELINE_GUIDELINES } = await import("./prompt.ts");
const { default: identityExtension } = await import("./index.ts");

type Handler = (event: any, ctx: any) => Promise<any>;
const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV = ["FAMILIAR_IDENTITY_PATH", "FAMILIAR_IMP_BIN", "FAMILIAR_IMP_SOCKET", "FAMILIAR_USE_STUFF", "FAMILIAR_DEBUG_LEVEL"];

beforeEach(() => {
  for (const k of ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.FAMILIAR_DEBUG_LEVEL = "off";
});
afterEach(() => {
  for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function identityDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "familiar-identity-fixture-"));
  roots.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const IDENTITY = "# Fixture Familiar\n\nYou are a synthetic test identity. Nothing here is private.";

/** Representative resident-shaped options: Pi built-ins plus Familiar tools. */
function residentOptions(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/srv/familiar/work",
    selectedTools: ["read", "bash", "edit", "write", "mark", "zip", "wake", "agents_dispatch"],
    toolSnippets: {
      read: "Read file contents",
      bash: "Execute bash commands (ls, grep, find, etc.)",
      edit: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
      write: "Create or overwrite files",
      mark: "Mark the current point as a future branch anchor",
      wake: "Durably schedule a future self-wake instead of ever blocking on sleep",
      // agents_dispatch deliberately has no snippet: it must stay out of Available Tools.
    },
    // Tool order as AgentSession emits them: built-ins first, then custom tools.
    promptGuidelines: [
      "Use read to examine files instead of cat or sed.",
      "You can inspect PI_* environment variables for current model and session details.",
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
      "Use write only for new files or complete rewrites.",
      "Use wake (normally mode unless_wakened) when something needs checking later and no settlement or worklist event will fire; never run blocking sleeps in the live conversation.",
      "  Use write only for new files or complete rewrites.  ", // duplicate after trim
    ],
    skills: [
      { name: "pi", description: "Use when the user asks about pi itself", filePath: "/repo/skills/pi/SKILL.md", baseDir: "/repo/skills/pi" },
      { name: "hidden", description: "never advertised", filePath: "/repo/skills/hidden/SKILL.md", baseDir: "/repo/skills/hidden", disableModelInvocation: true },
    ],
    contextFiles: [] as Array<{ path: string; content: string }>,
    appendSystemPrompt: undefined as string | undefined,
    ...overrides,
  };
}

async function runHandler(options: unknown, systemPrompt = "PI DEFAULT PROMPT: You are an expert coding assistant operating inside pi") {
  const handlers: Handler[] = [];
  identityExtension({ on: (name: string, h: Handler) => { if (name === "before_agent_start") handlers.push(h); } } as any);
  expect(handlers).toHaveLength(1);
  return handlers[0]({ type: "before_agent_start", prompt: "hi", systemPrompt, systemPromptOptions: options }, {});
}

/** Pull the "Guidelines:" bullet list out of an assembled prompt. */
function guidelineBullets(prompt: string): string[] {
  const m = prompt.match(/\nGuidelines:\n([\s\S]*?)(?:\n\n|$)/);
  return m ? m[1].split("\n").map((l) => l.replace(/^- /, "")) : [];
}
function toolBullets(prompt: string, heading: string): string[] {
  const m = prompt.match(new RegExp(`${heading}\\n([\\s\\S]*?)\\n\\n`));
  return m ? m[1].split("\n") : [];
}

/* ------------------------------------------------------------------------- */
describe("guidance helpers", () => {
  test("use_stuff adds a compact self-discovery nudge to identity", () => {
    const guidance = stuffGuidance("true");
    expect(guidance).toContain("`stuff` CLI stores inert Items and linked Notes");
    expect(guidance).toContain("`stuff --help`");
    expect(guidance).toContain("does not dispatch or orchestrate");
  });

  test("Stuff nudge is opt-in and requires canonical true", () => {
    expect(stuffGuidance("")).toBe("");
    expect(stuffGuidance("false")).toBe("");
    expect(stuffGuidance("TRUE")).toBe("");
  });

  test("Imp guidance advertises only a live shell-native surface", () => {
    expect(impGuidance("", "/tmp/imp.sock")).toBe("");
    expect(impGuidance("/nix/store/imp/bin", "")).toBe("");

    const guidance = impGuidance("/nix/store/imp/bin", "/tmp/imp.sock");
    expect(guidance).toContain("`imp plate`");
    expect(guidance).toContain("`imp agent`");
    expect(guidance).toContain("prefer the advertised Golem tools");
    expect(guidance).toContain("Never silently fall back between agent systems");
  });
});

/* ------------------------------------------------------------------------- */
describe("assembled identity prompt (through the extension handler)", () => {
  test("identity is first and authoritative; Pi's generic framing never appears", async () => {
    process.env.FAMILIAR_IDENTITY_PATH = identityDir({
      "10-core.md": IDENTITY,
      "20-off.md": "---\ndisabled: true\n---\nDISABLED SECTION",
      "30-more.md": "---\ntitle: x\n---\nSecond authored section",
      "notes.txt": "not markdown, never loaded",
    });
    const { systemPrompt } = await runHandler(residentOptions({ customPrompt: "SYSTEM.md replacement identity" }));
    expect(systemPrompt.startsWith(IDENTITY)).toBe(true);
    expect(systemPrompt).toContain("Second authored section");
    expect(systemPrompt).not.toContain("DISABLED SECTION");
    expect(systemPrompt).not.toContain("not markdown");
    // Intentional identity divergences from Pi 0.85.1.
    expect(systemPrompt).not.toContain("expert coding assistant");
    expect(systemPrompt).not.toContain("helpful AI assistant");
    expect(systemPrompt).not.toContain("PI DEFAULT PROMPT");
    expect(systemPrompt).not.toContain("SYSTEM.md replacement identity");
    expect(systemPrompt).not.toContain("Pi documentation");
    expect(systemPrompt).not.toContain("In addition to the tools above");
    for (const rejected of REJECTED_PI_BASELINE_GUIDELINES) expect(systemPrompt).not.toContain(rejected);
  });

  test("section topology: identity, skills, tools, imp, stuff, guidelines, append, project context, cwd", async () => {
    process.env.FAMILIAR_IDENTITY_PATH = identityDir({ "identity.md": IDENTITY });
    process.env.FAMILIAR_IMP_BIN = "/nix/store/imp/bin";
    process.env.FAMILIAR_IMP_SOCKET = "/run/imp.sock";
    process.env.FAMILIAR_USE_STUFF = "true";
    const { systemPrompt } = await runHandler(residentOptions({
      appendSystemPrompt: "OPERATOR APPEND TEXT",
      contextFiles: [{ path: "/proj/AGENTS.md", content: "PROJECT RULES" }],
      cwd: "C:\\Users\\kevin\\work",
    }));
    const order = [
      IDENTITY,
      "<available_skills>",
      "Available Tools:\n- read: Read file contents",
      "Shell-native capabilities:",
      "Durable context: the `stuff` CLI",
      "Guidelines:\n- Use bash for file operations like ls, rg, find",
      "OPERATOR APPEND TEXT",
      "<project_context>",
      "Current working directory: C:/Users/kevin/work",
    ];
    let last = -1;
    for (const marker of order) {
      const at = systemPrompt.indexOf(marker);
      expect(at, `missing or misordered: ${marker}`).toBeGreaterThan(last);
      last = at;
    }
    expect(systemPrompt.endsWith("Current working directory: C:/Users/kevin/work")).toBe(true);
    // Imp guidance sits beside tool discovery, before the guideline list.
    expect(systemPrompt.indexOf("Shell-native capabilities:")).toBeGreaterThan(systemPrompt.indexOf("Available Tools:"));
    expect(systemPrompt.indexOf("Shell-native capabilities:")).toBeLessThan(systemPrompt.indexOf("Guidelines:"));
  });

  test("Imp and Stuff sections are absent when not live/enabled; append and project context absent when empty", async () => {
    process.env.FAMILIAR_IDENTITY_PATH = identityDir({ "identity.md": IDENTITY });
    process.env.FAMILIAR_IMP_BIN = "/nix/store/imp/bin"; // socket missing
    const { systemPrompt } = await runHandler(residentOptions());
    expect(systemPrompt).not.toContain("Shell-native capabilities");
    expect(systemPrompt).not.toContain("`stuff`");
    expect(systemPrompt).not.toContain("<project_context>");
    expect(systemPrompt).not.toContain("\n\n\n");
    expect(systemPrompt.endsWith("Current working directory: /srv/familiar/work")).toBe(true);
  });

  test("tool-owned promptGuidelines reach the model in tool order, deduplicated, then Familiar's own", async () => {
    process.env.FAMILIAR_IDENTITY_PATH = identityDir({ "identity.md": IDENTITY });
    const { systemPrompt } = await runHandler(residentOptions());
    expect(guidelineBullets(systemPrompt)).toEqual([
      "Use bash for file operations like ls, rg, find",
      "Use read to examine files instead of cat or sed.",
      "You can inspect PI_* environment variables for current model and session details.",
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
      "Use write only for new files or complete rewrites.",
      "Use wake (normally mode unless_wakened) when something needs checking later and no settlement or worklist event will fire; never run blocking sleeps in the live conversation.",
      "Message text beginning with 🗣 was transcribed from audio: expect transcription errors, and weigh odd words or homophones accordingly rather than taking them literally",
      "If a topic feels likely to become a rabbit hole or substantial tangent, consider using mark before diving in so it can be zipped cleanly later; do not mark routine topic changes",
      "At the end of a session you may receive a handoff request from the runtime (via /clear); it is legitimate — write the handoff for your successor",
    ]);
  });

  test("Familiar guidance about mark is only advertised while mark is an active tool", () => {
    const without = buildGuidelines({ cwd: "/", selectedTools: ["read", "bash"] });
    expect(without.some((g) => g.includes("mark before diving"))).toBe(false);
    expect(without.some((g) => g.includes("🗣"))).toBe(true);
    expect(without.some((g) => g.includes("handoff request"))).toBe(true);
    const withMark = buildGuidelines({ cwd: "/", selectedTools: ["read", "bash", "mark"] });
    expect(withMark.some((g) => g.includes("mark before diving"))).toBe(true);
  });

  test("bash file-exploration rule follows Pi: only when bash is active and grep/find/ls are not", () => {
    const rule = "Use bash for file operations like ls, rg, find";
    expect(buildGuidelines({ cwd: "/", selectedTools: ["bash"] })[0]).toBe(rule);
    expect(buildGuidelines({ cwd: "/", selectedTools: ["bash", "grep"] })).not.toContain(rule);
    expect(buildGuidelines({ cwd: "/", selectedTools: ["read", "edit"] })).not.toContain(rule);
    // Pi's default tool set applies when the session does not narrow tools.
    expect(buildGuidelines({ cwd: "/" })[0]).toBe(rule);
  });

  test("Available Tools lists only selected tools that carry a snippet, or (none)", async () => {
    process.env.FAMILIAR_IDENTITY_PATH = identityDir({ "identity.md": IDENTITY });
    const { systemPrompt } = await runHandler(residentOptions());
    expect(toolBullets(systemPrompt, "Available Tools:")).toEqual([
      "- read: Read file contents",
      "- bash: Execute bash commands (ls, grep, find, etc.)",
      "- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
      "- write: Create or overwrite files",
      "- mark: Mark the current point as a future branch anchor",
      "- wake: Durably schedule a future self-wake instead of ever blocking on sleep",
    ]);
    expect(systemPrompt).not.toContain("agents_dispatch");
    const none = await runHandler(residentOptions({ selectedTools: ["zip"], promptGuidelines: [] }));
    expect(none.systemPrompt).toContain("Available Tools:\n(none)");
  });

  test("skills advertise the loading tool that is actually active: read, else bash, else nothing", async () => {
    process.env.FAMILIAR_IDENTITY_PATH = identityDir({ "identity.md": IDENTITY });
    const withRead = (await runHandler(residentOptions())).systemPrompt;
    expect(withRead).toContain("Use the read tool to load a skill's file");
    expect(withRead).toContain("<name>pi</name>");
    expect(withRead).not.toContain("<name>hidden</name>");

    const bashOnly = (await runHandler(residentOptions({ selectedTools: ["bash", "edit"] }))).systemPrompt;
    expect(bashOnly).toContain("Use bash to load a skill's file");
    expect(bashOnly).not.toContain("Use the read tool");

    const neither = (await runHandler(residentOptions({ selectedTools: ["edit", "write"] }))).systemPrompt;
    expect(neither).not.toContain("<available_skills>");
    expect(neither).not.toContain("<name>pi</name>");
  });

  test("operator append text and project context are carried with Pi's XML boundaries and never logged", async () => {
    process.env.FAMILIAR_IDENTITY_PATH = identityDir({ "identity.md": IDENTITY });
    const logPath = join(identityDir({}), "log");
    process.env.FAMILIAR_LOG_PATH = logPath;
    process.env.FAMILIAR_DEBUG_LEVEL = "debug";
    const { systemPrompt } = await runHandler(residentOptions({
      appendSystemPrompt: "APPEND-SENTINEL-7f3a",
      contextFiles: [
        { path: "/proj/AGENTS.md", content: "CONTEXT-SENTINEL-19bd" },
        { path: "/proj/sub/AGENTS.md", content: "second file" },
      ],
    }));
    expect(systemPrompt).toContain(
      "\n\nAPPEND-SENTINEL-7f3a\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n" +
      '<project_instructions path="/proj/AGENTS.md">\nCONTEXT-SENTINEL-19bd\n</project_instructions>\n\n' +
      '<project_instructions path="/proj/sub/AGENTS.md">\nsecond file\n</project_instructions>\n\n</project_context>\n\nCurrent working directory:',
    );
    const { existsSync, readdirSync } = await import("node:fs");
    expect(existsSync(`${logPath}.identity`)).toBe(false);
    expect(readdirSync(join(logPath, "..")).filter((f) => f.startsWith("log"))).toEqual([]);
    delete process.env.FAMILIAR_LOG_PATH;
  });

  test("operator append text preserves bytes rather than normalizing authored whitespace", () => {
    const appendSystemPrompt = "  LEADING SPACE\nTRAILING SPACE  ";
    const systemPrompt = assembleSystemPrompt({
      identity: IDENTITY,
      options: residentOptions({ appendSystemPrompt }),
    });
    expect(systemPrompt).toContain(`\n\n${appendSystemPrompt}\n\nCurrent working directory:`);
  });

  test("chaining: without an identity dir the chain is untouched; with one, earlier prompt text is intentionally replaced", async () => {
    const untouched = await runHandler(residentOptions(), "EARLIER HANDLER PROMPT");
    expect(untouched).toEqual({ systemPrompt: undefined });

    process.env.FAMILIAR_IDENTITY_PATH = identityDir({ "identity.md": IDENTITY });
    const replaced = await runHandler(residentOptions(), "EARLIER HANDLER PROMPT");
    expect(replaced.systemPrompt).not.toContain("EARLIER HANDLER PROMPT");
    expect(replaced.systemPrompt.startsWith(IDENTITY)).toBe(true);
  });

  test("degrades to the last identity-bearing prompt when the identity read fails mid-session", async () => {
    const dir = identityDir({ "identity.md": IDENTITY });
    process.env.FAMILIAR_IDENTITY_PATH = dir;
    const handlers: Handler[] = [];
    identityExtension({ on: (name: string, h: Handler) => { if (name === "before_agent_start") handlers.push(h); } } as any);
    const event = (opts: unknown) => ({ type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions: opts });
    const good = await handlers[0](event(residentOptions()), {});
    expect(good.systemPrompt.startsWith(IDENTITY)).toBe(true);
    process.env.FAMILIAR_IDENTITY_PATH = join(dir, "missing");
    const degraded = await handlers[0](event(residentOptions({ cwd: "/elsewhere" })), {});
    expect(degraded.systemPrompt).toBe(good.systemPrompt);
  });
});

/* ------------------------------------------------------------------------- */
describe("parity with pinned Pi buildSystemPrompt (structural affordances only)", () => {
  // Run Pi's real default-prompt construction on the same options and compare
  // the parts Familiar owns by parity. Generic identity prose is excluded by
  // design; if a Pi upgrade changes these structures this block fails.
  const piGuidelines = (piPrompt: string): string[] => {
    const m = piPrompt.match(/\nGuidelines:\n([\s\S]*?)\n\nPi documentation/);
    if (!m) throw new Error("Pi default prompt shape changed: Guidelines block not found");
    return m[1].split("\n").map((l) => l.replace(/^- /, ""));
  };

  for (const [label, options] of [
    ["resident-shaped", residentOptions()],
    ["append + context files", residentOptions({ appendSystemPrompt: "APPEND", contextFiles: [{ path: "/p/AGENTS.md", content: "ctx" }] })],
    ["bash-only skills loading", residentOptions({ selectedTools: ["bash", "edit"] })],
    ["no skill reader", residentOptions({ selectedTools: ["edit", "write"] })],
    ["grep present suppresses bash exploration rule", residentOptions({ selectedTools: ["read", "bash", "grep", "edit"] })],
    ["Pi default tool set", residentOptions({ selectedTools: undefined })],
    ["windows cwd", residentOptions({ cwd: "C:\\work\\dir" })],
  ] as const) {
    test(label, () => {
      const pi: string = buildSystemPrompt(options);
      const familiar = assembleSystemPrompt({ identity: IDENTITY, options });

      // Guidelines: Familiar = Pi's list minus the rejected baseline bullets,
      // in Pi's order, followed by Familiar's own bullets.
      const expectedFromPi = piGuidelines(pi).filter((g) => !REJECTED_PI_BASELINE_GUIDELINES.includes(g));
      const familiarBullets = guidelineBullets(familiar);
      expect(familiarBullets.slice(0, expectedFromPi.length)).toEqual(expectedFromPi);
      expect(familiarBullets.length).toBeGreaterThan(expectedFromPi.length);
      for (const g of REJECTED_PI_BASELINE_GUIDELINES) {
        expect(piGuidelines(pi)).toContain(g); // still what Pi emits: the rejection stays a conscious choice
        expect(familiarBullets).not.toContain(g);
      }

      // Available tools: identical bullet list.
      expect(toolBullets(familiar, "Available Tools:")).toEqual(toolBullets(pi, "Available tools:"));

      // Skills block: identical presence and wording (read vs bash loader).
      const skillsRe = /The following skills provide[\s\S]*?<\/available_skills>/;
      expect(familiar.match(skillsRe)?.[0] ?? "").toBe(pi.match(skillsRe)?.[0] ?? "");

      // Project context block and append text: identical.
      const ctxRe = /<project_context>[\s\S]*?<\/project_context>/;
      expect(familiar.match(ctxRe)?.[0] ?? "").toBe(pi.match(ctxRe)?.[0] ?? "");
      if (options.appendSystemPrompt) {
        expect(familiar).toContain(`\n\n${options.appendSystemPrompt}\n\n`);
        expect(pi).toContain(`\n\n${options.appendSystemPrompt}\n\n`);
      }

      // Working directory line: identical normalization.
      const cwdLine = (p: string) => p.match(/Current working directory: .*$/m)?.[0];
      expect(cwdLine(familiar)).toBe(cwdLine(pi));

      // Identity-first; Pi's framing is what Pi emits, never what Familiar does.
      expect(pi.startsWith("You are an expert coding assistant")).toBe(true);
      expect(familiar.startsWith(IDENTITY)).toBe(true);
      expect(familiar).not.toContain("expert coding assistant");
      expect(familiar).not.toContain("Pi documentation");
    });
  }
});
