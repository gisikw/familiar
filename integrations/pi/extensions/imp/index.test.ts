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

function harness(initial: any[]) {
  const entries = initial;
  const handlers = new Map<string, Handler[]>();
  let sequence = 0;
  let shutdowns = 0;
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    appendEntry(customType: string, data: unknown) {
      const entry = { type: "custom", id: `new-${++sequence}`, customType, data };
      entries.push(entry);
      return entry.id;
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
    shutdown: () => { shutdowns++; },
  };
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name, reason: "startup" }, ctx);
  };
  return { entries, emit, shutdowns: () => shutdowns };
}

const forkPrefix = () => [
  { type: "custom", id: "fork-marker", customType: "familiar.fork.v1", data: { parentSessionId: "parent", branchEntryId: "branch" } },
  { type: "custom", id: "fork-note", customType: "familiar.fork-note.v1", data: {} },
  { type: "message", id: "task", message: { role: "user", content: "do it" } },
];

test("settled merge uses the true leaf, carries last words, then becomes terminal", async () => {
  const service = await serviceServer();
  process.env.FAMILIAR_SERVICES_SOCKET = service.path;
  process.env.FAMILIAR_INSTANCE_ID = "fork-1";
  const h = harness(forkPrefix());
  await h.emit("session_start");

  (process as any)[IMP_BRANCH_HANDLER].handle({ operation: "merge", args: { text: "I fixed it", quiet: true } });
  h.entries.push(
    { type: "message", id: "tool-result", message: { role: "toolResult", content: [{ type: "text", text: "merge queued" }] } },
    { type: "message", id: "true-leaf", message: { role: "assistant", content: [{ type: "text", text: "One caveat remains." }] } },
  );

  await h.emit("agent_settled");
  const wire = await service.request;
  await service.close();
  const body = JSON.parse(wire.args.body);
  expect(wire.op).toBe("schedule.enqueue");
  expect(wire.args.urgency).toBe("soft");
  expect(body.lastEntryId).toBe("true-leaf");
  expect(body.turnCount).toBe(3);
  expect(body.summary).toBe("I fixed it\n\nlast words:\nOne caveat remains.");
  expect(h.entries.at(-1)).toMatchObject({ customType: "familiar.merge-sent.v1", data: { lastEntryId: "true-leaf" } });
  expect(h.entries.slice(h.entries.findIndex((entry) => entry.customType === "familiar.merge-sent.v1") + 1)
    .some((entry) => entry.message?.role === "assistant")).toBe(false);
  expect(h.shutdowns()).toBe(1);
});

test("the latest persisted pending merge is sent after a restart settle", async () => {
  const service = await serviceServer();
  process.env.FAMILIAR_SERVICES_SOCKET = service.path;
  process.env.FAMILIAR_INSTANCE_ID = "fork-2";
  const entries = forkPrefix();
  entries.push(
    { type: "custom", id: "pending-old", customType: "familiar.merge-pending.v1", data: { summary: "old", quiet: false } },
    { type: "custom", id: "pending-new", customType: "familiar.merge-pending.v1", data: { summary: "replacement", quiet: false } },
    { type: "message", id: "restart-leaf", message: { role: "assistant", content: [] } },
  );
  const h = harness(entries);
  await h.emit("session_start");
  await h.emit("agent_settled");

  const wire = await service.request;
  await service.close();
  expect(wire.args.summary).toBe("replacement");
  expect(JSON.parse(wire.args.body).lastEntryId).toBe("restart-leaf");
  expect(h.shutdowns()).toBe(1);
});
