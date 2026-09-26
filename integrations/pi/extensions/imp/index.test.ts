import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import impExtension from "./index.ts";
import { IMP_BRANCH_HANDLER } from "./ingress.mjs";

type Handler = (event: any, ctx: any) => Promise<void> | void;
const roots: string[] = [];

afterEach(() => {
  delete (process as any)[IMP_BRANCH_HANDLER];
  delete process.env.FAMILIAR_INSTANCE_ID;
  delete process.env.FAMILIAR_SERVICES_SOCKET;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function serviceServer() {
  const root = mkdtempSync(join(tmpdir(), "familiar-merge-test-"));
  roots.push(root);
  const path = join(root, "services.sock");
  let resolveRequest!: (request: any) => void;
  const request = new Promise<any>((resolve) => { resolveRequest = resolve; });
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      resolveRequest(JSON.parse(input.slice(0, newline)));
      socket.end('{"ok":true,"result":{"queued":true}}\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, request, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function harness(initial: any[], idle = false) {
  const entries = initial;
  const handlers = new Map<string, Handler[]>();
  const activeToolSets: string[][] = [];
  const sentMessages: any[] = [];
  let sequence = 0;
  let shutdowns = 0;
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    appendEntry(customType: string, data: unknown) {
      const entry = { type: "custom", id: `new-${++sequence}`, customType, data };
      entries.push(entry);
      return entry.id;
    },
    setActiveTools(names: string[]) { activeToolSets.push([...names]); },
    sendMessage(message: any, options: any) {
      sentMessages.push({ message, options });
      entries.push({ type: "custom_message", id: `new-${++sequence}`, ...message });
    },
  };
  impExtension(pi as any);
  const ctx = {
    mode: "print",
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => "/state/fork.jsonl",
      getBranch: () => entries,
    },
    isIdle: () => idle,
    shutdown: () => { shutdowns++; },
  };
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name, reason: "startup" }, ctx);
  };
  const toolCall = async () => {
    let result: any;
    for (const handler of handlers.get("tool_call") ?? []) result = (await handler({ type: "tool_call", toolName: "bash" }, ctx)) ?? result;
    return result;
  };
  return { entries, emit, toolCall, activeToolSets, sentMessages, shutdowns: () => shutdowns };
}

const forkPrefix = () => [
  { type: "custom", id: "fork-marker", customType: "familiar.fork.v1", data: { parentSessionId: "parent", branchEntryId: "branch" } },
  { type: "custom", id: "fork-note", customType: "familiar.fork-note.v1", data: {} },
  { type: "message", id: "task", message: { role: "user", content: "do it" } },
];

test("the harness prompts a tool-free return turn and sends that turn as the merge", async () => {
  const service = await serviceServer();
  process.env.FAMILIAR_SERVICES_SOCKET = service.path;
  process.env.FAMILIAR_INSTANCE_ID = "fork-1";
  const h = harness(forkPrefix());
  await h.emit("session_start");

  (process as any)[IMP_BRANCH_HANDLER].handle({ operation: "merge", args: { quiet: true } });
  h.entries.push(
    { type: "message", id: "tool-result", message: { role: "toolResult", content: [{ type: "text", text: "merge queued" }] } },
    { type: "message", id: "work-leaf", message: { role: "assistant", content: [{ type: "text", text: "Finishing the work first." }] } },
  );
  await h.emit("agent_settled");

  expect(h.activeToolSets).toEqual([]);
  expect(await h.toolCall()).toMatchObject({ block: true });
  expect(h.sentMessages).toHaveLength(1);
  expect(h.sentMessages[0]).toMatchObject({
    message: { customType: "familiar.merge-return-request.v1" },
    options: { triggerTurn: true, deliverAs: "followUp" },
  });
  expect(h.sentMessages[0].message.content).toBe("Write your return to parent: what you're bringing home, in your own voice. This message is the merge; nothing follows it.");

  h.entries.push({ type: "message", id: "return-leaf", message: { role: "assistant", content: [{ type: "text", text: "I fixed the race and kept the tests green." }] } });
  await h.emit("agent_settled");
  const wire = await service.request;
  await service.close();
  const body = JSON.parse(wire.args.body);
  expect(wire.op).toBe("schedule.enqueue");
  expect(wire.args.urgency).toBe("soft");
  expect(wire.args.summary).toBe("I fixed the race and kept the tests green.");
  expect(body.lastEntryId).toBe("return-leaf");
  expect(body.summary).toBe("I fixed the race and kept the tests green.");
  expect(h.entries.at(-1)).toMatchObject({ customType: "familiar.merge-sent.v1", data: { lastEntryId: "return-leaf" } });
  expect(h.entries.slice(h.entries.findIndex((entry) => entry.customType === "familiar.merge-sent.v1") + 1)).toEqual([]);
  expect(h.shutdowns()).toBe(1);
});

test("operator merge while idle enters the same prompted path", async () => {
  process.env.FAMILIAR_INSTANCE_ID = "fork-operator";
  const h = harness(forkPrefix(), true);
  await h.emit("session_start");
  (process as any)[IMP_BRANCH_HANDLER].operatorMerge(false);
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(h.entries.find((entry) => entry.customType === "familiar.merge-pending.v1")?.data)
    .toEqual({ quiet: false, requestedBy: "operator" });
  expect(h.entries.some((entry) => entry.customType === "familiar.merge-return-requested.v1")).toBe(true);
  expect(h.sentMessages).toHaveLength(1);
  expect(h.activeToolSets).toEqual([]);
  expect(await h.toolCall()).toMatchObject({ block: true });
});

test("restart after return request re-requests instead of sending the old work answer", async () => {
  const service = await serviceServer();
  process.env.FAMILIAR_SERVICES_SOCKET = service.path;
  process.env.FAMILIAR_INSTANCE_ID = "fork-restart";
  const entries = forkPrefix();
  entries.push(
    { type: "message", id: "old-work", message: { role: "assistant", content: [{ type: "text", text: "not the return" }] } },
    { type: "custom", id: "pending", customType: "familiar.merge-pending.v1", data: { quiet: false, requestedBy: "self" } },
    { type: "custom", id: "requested", customType: "familiar.merge-return-requested.v1", data: { pendingEntryId: "pending" } },
    { type: "custom_message", id: "lost-prompt", customType: "familiar.merge-return-request.v1", content: "lost during crash" },
  );
  const h = harness(entries, true);
  await h.emit("session_start");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(h.sentMessages).toHaveLength(1);
  expect(h.activeToolSets).toEqual([]);
  expect(await h.toolCall()).toMatchObject({ block: true });

  h.entries.push({ type: "message", id: "return-after-restart", message: { role: "assistant", content: [] } });
  await h.emit("agent_settled");
  const wire = await service.request;
  await service.close();
  expect(wire.args.summary).toBe("(no return written)");
  expect(JSON.parse(wire.args.body).lastEntryId).toBe("return-after-restart");
  expect(h.shutdowns()).toBe(1);
});

test("a runner's return is flagged as not Kes", async () => {
  const service = await serviceServer();
  process.env.FAMILIAR_SERVICES_SOCKET = service.path;
  process.env.FAMILIAR_INSTANCE_ID = "runner-1";
  const prefix = forkPrefix();
  prefix[0] = { ...prefix[0], data: { parentSessionId: "parent", branchEntryId: "branch", fresh: true, role: "runner", model: "p/light-model" } };
  const h = harness(prefix);
  await h.emit("session_start");
  (process as any)[IMP_BRANCH_HANDLER].handle({ operation: "merge", args: { quiet: true } });
  h.entries.push({ type: "message", id: "work", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
  await h.emit("agent_settled");
  h.entries.push({ type: "message", id: "ret", message: { role: "assistant", content: [{ type: "text", text: "Here is the briefing." }] } });
  await h.emit("agent_settled");
  const wire = await service.request;
  await service.close();
  expect(wire.args.summary).toBe("[runner on p/light-model, not Kes]\n\nHere is the briefing.");
});
