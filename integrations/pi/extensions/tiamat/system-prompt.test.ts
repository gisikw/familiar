import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { registerSystemPromptRecorder, SYSTEM_PROMPT_ENTRY } from "./system-prompt.ts";

const root = process.env.PI_PACKAGE_DIR;
if (!root) throw new Error("PI_PACKAGE_DIR is required");
const { buildSessionContext } = await import(join(root, "dist/index.js"));
type Entry = Record<string, any>;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const records = (entries: Entry[]) => entries.filter((e) => e.type === "custom" && e.customType === SYSTEM_PROMPT_ENTRY);

function harness(branch: Entry[] = []) {
  let prompt = "first prompt";
  let run: (event: unknown, ctx: any) => void = () => {};
  const pi = {
    on: (name: string, handler: typeof run) => { if (name === "agent_start") run = handler; },
    appendEntry: (customType: string, data: unknown) => branch.push({
      type: "custom", id: `e${branch.length}`, parentId: branch.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(), customType, data,
    }),
  };
  registerSystemPromptRecorder(pi as any);
  const ctx = { getSystemPrompt: () => prompt, sessionManager: { getBranch: () => branch } };
  return { branch, run: () => run({}, ctx), setPrompt: (text: string) => { prompt = text; } };
}

describe("system prompt session record", () => {
  test("records first and changed prompts, but not an unchanged second turn", () => {
    const h = harness();
    h.run(); h.run();
    expect(records(h.branch).map((e) => e.data)).toEqual([{ sha256: digest("first prompt"), text: "first prompt" }]);
    h.setPrompt("changed prompt\nexactly"); h.run();
    expect(records(h.branch).at(-1)?.data).toEqual({ sha256: digest("changed prompt\nexactly"), text: "changed prompt\nexactly" });
  });

  test("compares with the most recent record on the current branch", () => {
    const h = harness([
      { type: "custom", id: "old", customType: SYSTEM_PROMPT_ENTRY, data: { sha256: digest("stale") } },
      { type: "custom", id: "new", customType: SYSTEM_PROMPT_ENTRY, data: { sha256: digest("first prompt") } },
    ]);
    h.run();
    expect(records(h.branch)).toHaveLength(2);
  });

  test("custom prompt records never enter model context", () => {
    const secret = { type: "custom", id: "p", parentId: null, customType: SYSTEM_PROMPT_ENTRY, data: { text: "SECRET" } };
    const message = { type: "message", id: "m", parentId: "p", message: { role: "user", content: "hello" } };
    const context = buildSessionContext([secret, message] as any, "m").messages;
    expect(context).toEqual([message.message]);
    expect(JSON.stringify(context)).not.toContain("SECRET");
  });
});
