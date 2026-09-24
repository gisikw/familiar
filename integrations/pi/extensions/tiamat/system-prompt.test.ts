import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { registerSystemPromptRecorder, SYSTEM_PROMPT_ENTRY } from "./system-prompt.ts";

const piPackageDir = process.env.PI_PACKAGE_DIR;
if (!piPackageDir) throw new Error("PI_PACKAGE_DIR is required (point it at Familiar's pinned Pi package)");
const { buildSessionContext } = await import(join(piPackageDir, "dist/index.js"));

type Entry = Record<string, any>;

function harness(initial: Entry[] = []) {
  const branch = [...initial];
  let handler: (event: unknown, ctx: any) => void = () => {};
  let prompt = "first prompt";
  let serial = branch.length;
  const pi = {
    on(name: string, candidate: typeof handler) {
      if (name === "agent_start") handler = candidate;
    },
    appendEntry(customType: string, data: unknown) {
      const parentId = branch.at(-1)?.id ?? null;
      branch.push({ type: "custom", id: `e${++serial}`, parentId, timestamp: new Date().toISOString(), customType, data });
    },
  };
  registerSystemPromptRecorder(pi as any);
  const ctx = {
    getSystemPrompt: () => prompt,
    sessionManager: { getBranch: () => branch },
  };
  return {
    branch,
    run: () => handler({ type: "agent_start" }, ctx),
    setPrompt: (value: string) => { prompt = value; },
  };
}

const records = (entries: Entry[]) => entries.filter(
  (entry) => entry.type === "custom" && entry.customType === SYSTEM_PROMPT_ENTRY,
);

describe("system prompt session record", () => {
  test("writes once, stays quiet for an unchanged turn, and records a change", () => {
    const h = harness();
    h.run();
    expect(records(h.branch)).toEqual([expect.objectContaining({
      data: {
        sha256: createHash("sha256").update("first prompt").digest("hex"),
        text: "first prompt",
      },
    })]);

    h.run();
    expect(records(h.branch)).toHaveLength(1);

    h.setPrompt("changed prompt\nexactly");
    h.run();
    expect(records(h.branch)).toHaveLength(2);
    expect(records(h.branch).at(-1)?.data.text).toBe("changed prompt\nexactly");
  });

  test("compares with the most recent record on the current branch", () => {
    const stale = createHash("sha256").update("stale").digest("hex");
    const current = createHash("sha256").update("first prompt").digest("hex");
    const h = harness([
      { type: "custom", id: "old", parentId: null, customType: SYSTEM_PROMPT_ENTRY, data: { sha256: stale, text: "stale" } },
      { type: "custom", id: "new", parentId: "old", customType: SYSTEM_PROMPT_ENTRY, data: { sha256: current, text: "first prompt" } },
    ]);
    h.run();
    expect(records(h.branch)).toHaveLength(2);
  });

  test("custom prompt records never enter model context", () => {
    const entries = [{
      type: "custom", id: "prompt", parentId: null, timestamp: new Date().toISOString(),
      customType: SYSTEM_PROMPT_ENTRY, data: { sha256: "fixture", text: "SECRET SYSTEM PROMPT" },
    }, {
      type: "message", id: "user", parentId: "prompt", timestamp: new Date().toISOString(),
      message: { role: "user", content: "hello", timestamp: Date.now() },
    }];
    const context = buildSessionContext(entries as any, "user");
    expect(context.messages).toEqual([entries[1].message]);
    expect(JSON.stringify(context.messages)).not.toContain("SECRET SYSTEM PROMPT");
  });
});
