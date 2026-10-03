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
  let run: (event: unknown, ctx: any) => unknown = () => {};
  const pi = {
    on: (name: string, handler: typeof run) => { if (name === "before_provider_request") run = handler; },
    appendEntry: (customType: string, data: unknown) => branch.push({
      type: "custom", id: `e${branch.length}`, parentId: branch.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(), customType, data,
    }),
  };
  registerSystemPromptRecorder(pi as any);
  const ctx = { sessionManager: { getBranch: () => branch } };
  return { branch, send: (payload: unknown) => run({ type: "before_provider_request", payload }, ctx) };
}
const anthropic = (text: string) => ({ model: "m", system: [{ type: "text", text, cache_control: { type: "ephemeral" } }], messages: [] });

describe("system prompt session record", () => {
  test("records the prompt on the wire: first and changed, not an unchanged second request", () => {
    const h = harness();
    h.send(anthropic("first prompt")); h.send(anthropic("first prompt"));
    expect(records(h.branch).map((e) => e.data)).toEqual([{ sha256: digest("first prompt"), text: "first prompt" }]);
    h.send(anthropic("changed prompt\nexactly"));
    expect(records(h.branch).at(-1)?.data).toEqual({ sha256: digest("changed prompt\nexactly"), text: "changed prompt\nexactly" });
  });

  test("reads OpenAI chat and Responses shapes; ignores unknown shapes; never rewrites the payload", () => {
    const h = harness();
    expect(h.send({ messages: [{ role: "system", content: "chat prompt" }, { role: "user", content: "hi" }] })).toBeUndefined();
    expect(h.send({ instructions: "responses prompt", input: [] })).toBeUndefined();
    expect(h.send({ contents: [] })).toBeUndefined();
    expect(records(h.branch).map((e) => e.data.text)).toEqual(["chat prompt", "responses prompt"]);
  });

  test("compares with the most recent record on the current branch", () => {
    const h = harness([
      { type: "custom", id: "old", customType: SYSTEM_PROMPT_ENTRY, data: { sha256: digest("stale") } },
      { type: "custom", id: "new", customType: SYSTEM_PROMPT_ENTRY, data: { sha256: digest("first prompt") } },
    ]);
    h.send(anthropic("first prompt"));
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
