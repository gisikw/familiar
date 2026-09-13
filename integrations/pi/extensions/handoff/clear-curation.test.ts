import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Drive the real handoff extension through a fake pi/ctx. Pi's packages are
// mocked at the module boundary; retain their real exports because Bun mocks
// are process-global and the canonical suite later exercises Pi's real loader.
const piPackageDir = process.env.PI_PACKAGE_DIR;
if (!piPackageDir) throw new Error("PI_PACKAGE_DIR is required (run in Familiar's pi or agents dev shell)");
const realCodingAgent = await import(path.join(piPackageDir, "dist/index.js"));
const realPiAi = await import(path.join(piPackageDir, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const realTypebox = await import(path.join(piPackageDir, "node_modules/typebox/build/index.mjs"));
mock.module("@earendil-works/pi-coding-agent", () => ({
  ...realCodingAgent,
  buildSessionContext: (entries: any[]) => ({ messages: entries.map((e) => e.message) }),
  convertToLlm: (messages: any[]) => messages.map((m) => ({ ...m })),
}));
mock.module("@earendil-works/pi-ai", () => ({ ...realPiAi, uuidv7: () => "uuid-v7" }));
mock.module("typebox", () => ({
  ...realTypebox,
  Type: { ...realTypebox.Type, Object: (o: any) => o, Optional: (o: any) => o, String: (o: any) => o },
}));

type Handler = (event: any, ctx: any) => Promise<any>;

const roots: string[] = [];
let handoffDir = "";
let storeDir = "";

beforeEach(() => {
  handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-handoff-"));
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-subconscious-"));
  roots.push(handoffDir, storeDir);
  process.env.FAMILIAR_HANDOFF_PATH = handoffDir;
  process.env.FAMILIAR_SUBCONSCIOUS_DIR = storeDir;
  process.env.FAMILIAR_DEBUG_LEVEL = "off";
  process.env.FAMILIAR_SUBCONSCIOUS_TIMEOUT_MS = "200";
});
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const reminders = () => {
  const file = path.join(storeDir, "reminders.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).reminders : [];
};

async function harness(options: {
  curation?: (request: any) => Promise<any> | any;
  entries?: any[];
} = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const tools = new Map<string, any>();
  const persisted: Array<{ kind: string; payload: unknown }> = [];
  const trace: string[] = [];
  const completions: Array<{ model: unknown; request: any; options: any }> = [];
  const pi = {
    on: (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand: (name: string, command: any) => { commands.set(name, command); },
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    sendMessage: (message: unknown, options: unknown) => { persisted.push({ kind: "sendMessage", payload: { message, options } }); },
    appendEntry: (type: string, data: unknown) => { persisted.push({ kind: "appendEntry", payload: { type, data } }); },
    sendUserMessage: (message: unknown) => { persisted.push({ kind: "sendUserMessage", payload: message }); },
  };
  const model = { provider: "anthropic", id: "outgoing-model", maxTokens: 8192, contextWindow: 200_000 };
  const entries = options.entries ?? [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "the whole conversation so far" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "and my part of it" }] } },
  ];
  let compactRequest: { onComplete: () => void; onError: (e: Error) => void } | null = null;
  const ctx = {
    hasUI: false,
    model,
    modelRegistry: {
      complete: async (m: unknown, request: any, opts: any) => {
        completions.push({ model: m, request, options: opts });
        const last = request.messages.at(-1)?.content?.[0]?.text ?? "";
        if (last.startsWith("This context is about to be compacted")) {
          trace.push("handoff-inference");
          return { stopReason: "stop", content: [{ type: "text", text: "# Handoff\n\nwhat shipped" }], usage: { input: 1, output: 1 } };
        }
        trace.push("curation-inference");
        expect(last.startsWith("Your handoff is written")).toBe(true);
        const reply = await (options.curation ?? (() => '{"ops":[]}'))({ request, last, signal: opts.signal });
        return typeof reply === "string" ? { stopReason: "stop", content: [{ type: "text", text: reply }] } : reply;
      },
    },
    getSystemPrompt: () => "SYSTEM PROMPT",
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
      getLeafId: () => "leaf-1",
      getSessionId: () => "session-abcdef12",
    },
    compact: (request: any) => { trace.push("ctx.compact"); compactRequest = request; },
    waitForIdle: async () => {},
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000 }),
    ui: { notify() {}, setWorkingMessage() {} },
  };
  const { default: handoffExtension } = await import("./index.ts");
  handoffExtension(pi as any);
  const emit = async (name: string, event: any = {}) => {
    let result: any;
    for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
    return result;
  };
  await emit("session_start", { reason: "startup" });
  const signal = new AbortController().signal;
  const beforeCompact = (extra: any = {}) => emit("session_before_compact", {
    preparation: { tokensBefore: 5000, firstKeptEntryId: "x" },
    branchEntries: entries,
    reason: "manual",
    willRetry: false,
    signal,
    ...extra,
  });
  return {
    pi, ctx, emit, commands, tools, persisted, trace, completions, beforeCompact, model,
    compactRequest: () => compactRequest,
  };
}

const archiveFiles = () => fs.readdirSync(handoffDir).filter((f) => f.endsWith(".md"));

describe("/clear curates the subconscious from the outgoing context", () => {
  test("handoff first, then exactly one ephemeral curation, then the compaction — nothing persisted", async () => {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, "reminders.json"), JSON.stringify({
      version: 1,
      reminders: [{ id: "r-0000aaaa", text: "old one", priority: "low", turns: 3, createdAt: 1, origin: { sessionId: null, handoffArchive: null } }],
    }));
    const h = await harness({
      curation: ({ request }) => {
        // Ownership: the outgoing context, the handoff prompt, the handoff itself, then the ask.
        const texts = request.messages.map((m: any) => `${m.role}:${m.content[0].text.slice(0, 24)}`);
        expect(texts).toEqual([
          "user:the whole conversation s",
          "assistant:and my part of it",
          "user:This context is about to",
          "assistant:# Handoff\n\nwhat shipped",
          "user:Your handoff is written.",
        ]);
        expect(request.messages.at(-1).content[0].text).toContain("r-0000aaaa");
        expect(archiveFiles()).toHaveLength(1); // the handoff already exists on disk
        return '{"ops":[{"op":"set","id":"r-0000aaaa","priority":"high"},{"op":"add","text":"ask Kevin about the Johnson call","priority":"normal"}]}';
      },
    });

    await h.commands.get("clear")!.handler("", h.ctx);
    expect(h.trace).toEqual(["ctx.compact"]);
    const result = await h.beforeCompact();

    expect(h.trace).toEqual(["ctx.compact", "handoff-inference", "curation-inference"]);
    expect(h.completions).toHaveLength(2);
    expect(h.completions[1].model).toBe(h.model);
    expect(h.completions[1].request.systemPrompt).toBe("SYSTEM PROMPT");
    expect(h.completions[1].options.maxTokens).toBe(2048);

    // The compaction Pi will append is the handoff alone; the curation turn
    // exists nowhere in the session.
    expect(result.compaction.summary).toBe("# Handoff\n\nwhat shipped");
    expect(result.compaction.details.archive).toBe(path.join(handoffDir, archiveFiles()[0]));
    expect(JSON.stringify(result)).not.toContain("Johnson");
    expect(JSON.stringify(result)).not.toContain("ops");
    expect(h.persisted).toEqual([]);
    expect(fs.readFileSync(result.compaction.details.archive, "utf8")).toBe("# Handoff\n\nwhat shipped\n");

    // Only the store changed.
    const stored = reminders();
    expect(stored.map((r: any) => [r.text, r.priority])).toEqual([["old one", "high"], ["ask Kevin about the Johnson call", "normal"]]);
    expect(stored[1].origin).toEqual({ sessionId: "session-abcdef12", handoffArchive: result.compaction.details.archive });

    // One /clear, one dispatch: a second before_compact for the same trigger does not curate again.
    await h.beforeCompact();
    expect(h.trace.filter((t) => t === "curation-inference")).toHaveLength(1);
  });

  test("a clear tool schedule also curates; automatic saturation handoffs and native /compact do not", async () => {
    const h = await harness();
    // Native /compact: nothing of ours triggered it.
    await h.beforeCompact();
    expect(h.trace).toEqual(["handoff-inference"]);

    // Automatic 90% handoff.
    h.ctx.getContextUsage = () => ({ tokens: 190_000, contextWindow: 200_000 });
    await h.emit("turn_end");
    await h.emit("agent_settled");
    expect(h.trace.at(-1)).toBe("ctx.compact");
    await h.beforeCompact();
    expect(h.trace.filter((t) => t === "curation-inference")).toHaveLength(0);
    h.compactRequest()!.onComplete();

    // Model-scheduled clear tool.
    h.ctx.getContextUsage = () => ({ tokens: 1000, contextWindow: 200_000 });
    await h.tools.get("clear")!.execute("call-1", {});
    await h.emit("agent_settled");
    await h.beforeCompact();
    expect(h.trace.filter((t) => t === "curation-inference")).toHaveLength(1);
  });

  test("overflow retries never curate", async () => {
    const h = await harness();
    await h.commands.get("clear")!.handler("", h.ctx);
    await h.beforeCompact({ reason: "overflow", willRetry: true });
    expect(h.trace).toEqual(["ctx.compact", "handoff-inference"]);
  });

  test("a no-op reply leaves the store untouched and /clear completes", async () => {
    const h = await harness({ curation: () => '{"ops":[]}' });
    await h.commands.get("clear")!.handler("", h.ctx);
    const result = await h.beforeCompact();
    expect(result.compaction.summary).toBe("# Handoff\n\nwhat shipped");
    expect(fs.existsSync(path.join(storeDir, "reminders.json"))).toBe(false);
  });

  test("prose, provider errors, thrown failures, and a hung model all degrade to a plain /clear", async () => {
    const failures = [
      () => "Sure, I'd like to remind myself about the Johnson call.",
      () => ({ stopReason: "error", errorMessage: "model unavailable", content: [] }),
      () => { throw new Error("socket hang up"); },
      ({ signal }: any) => new Promise((resolve) => { signal.addEventListener("abort", () => resolve({ stopReason: "aborted", content: [] })); }),
    ];
    for (const curation of failures) {
      const h = await harness({ curation });
      await h.commands.get("clear")!.handler("", h.ctx);
      const result = await h.beforeCompact();
      expect(h.trace).toEqual(["ctx.compact", "handoff-inference", "curation-inference"]);
      expect(result.compaction.summary).toBe("# Handoff\n\nwhat shipped");
      expect(h.persisted).toEqual([]);
      expect(reminders()).toEqual([]);
    }
  });

  test("an unusable store disables curation without touching the handoff", async () => {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.writeFileSync(storeDir, "not a directory");
    const h = await harness();
    await h.commands.get("clear")!.handler("", h.ctx);
    const result = await h.beforeCompact();
    expect(h.trace).toEqual(["ctx.compact", "handoff-inference"]);
    expect(result.compaction.summary).toBe("# Handoff\n\nwhat shipped");
    fs.rmSync(storeDir, { force: true });
    fs.mkdirSync(storeDir);
  });
});

describe("delivery to the next Familiar", () => {
  test("a reminder arrives hidden on an ordinary human turn, once, and never during orientation", async () => {
    fs.writeFileSync(path.join(storeDir, "reminders.json"), JSON.stringify({
      version: 1,
      reminders: [{ id: "r-0000aaaa", text: "remember the Johnson call", priority: "high", turns: 39, createdAt: 1, origin: { sessionId: "session-abcdef12", handoffArchive: "/h/a.md" } }],
    }));
    // A session that just compacted and has not yet oriented.
    const entries = [{ type: "compaction", summary: "# Handoff", details: { kind: "familiar-handoff", archive: "/h/a.md" } }];
    const h = await harness({ entries });

    // The next Familiar's first input is stashed; orientation runs and must not draw.
    expect(await h.emit("input", { text: "hi" })).toEqual({ action: "handled" });
    expect(await h.emit("before_agent_start", {})).toBeUndefined();
    await h.emit("agent_settled");
    expect(reminders()).toHaveLength(1);
    expect(h.persisted.map((p) => p.kind)).toEqual(["appendEntry", "sendMessage", "appendEntry", "sendUserMessage"]);

    // The released input becomes an ordinary human turn: the reminder surfaces.
    expect(await h.emit("input", { text: "hi" })).toEqual({ action: "continue" });
    const injected = await h.emit("before_agent_start", {});
    expect(injected.message.customType).toBe("subconscious-reminder");
    expect(injected.message.display).toBe(false);
    expect(injected.message.content).toContain("remember the Johnson call");
    expect(injected.message.content).toContain("handoff /h/a.md");
    expect(reminders()).toEqual([]);

    // Nothing is left, and turns that did not come from input never draw.
    expect(await h.emit("before_agent_start", {})).toBeUndefined();
    await h.emit("input", { text: "again" });
    expect(await h.emit("before_agent_start", {})).toBeUndefined();
  });
});
