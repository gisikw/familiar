import { afterEach, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import scheduler from "./index.ts";

// A quiet return held for Kev's next turn is requeued by familiar-services as
// a wake (Do Disturb switched on, or Kev tapped it in Open). The wake starts a
// turn and replaces the held copy: nothing is left to ride his next message.

const roots: string[] = [];
const savedSocket = process.env.FAMILIAR_SERVICES_SOCKET;
afterEach(() => {
  if (savedSocket === undefined) delete process.env.FAMILIAR_SERVICES_SOCKET; else process.env.FAMILIAR_SERVICES_SOCKET = savedSocket;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const body = JSON.stringify({ summary: "home", forkSessionId: "f", forkSessionFile: "/x", branchEntryId: "b", firstEntryId: "1", lastEntryId: "2", turnCount: 2, forkedFurther: false, mergedAt: "" });
const held = { id: "merge-f-abc", due_at: 0, target: "instance:p", origin: "f", source: "imp.merge", priority: 2, type: "merge", summary: "home", body, urgency: "soft" as const, state: "delivered", created_at: 0 };

test("a held quiet return requeued as a wake starts a turn and leaves no held copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "sched-held-"));
  roots.push(root);
  const socketPath = join(root, "svc.sock");
  process.env.FAMILIAR_SERVICES_SOCKET = socketPath;
  const acks: string[] = [];
  let peer: Socket | undefined;
  const server = createServer((socket: Socket) => {
    peer = socket;
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (msg.op === "hello") { socket.write(`${JSON.stringify({ ok: true, result: {} })}\n`); socket.write(`${JSON.stringify({ event: held })}\n`); }
        if (msg.op === "schedule.ack") acks.push(msg.args.id);
      }
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));

  const handlers = new Map<string, Array<(e: any, ctx: any) => any>>();
  const next: any[] = [];
  const steers: any[] = [];
  const pi = {
    on(name: string, h: any) { handlers.set(name, [...(handlers.get(name) ?? []), h]); },
    appendEntry() {},
    sendMessage(message: any, options: any) {
      if (options?.deliverAs === "nextTurn") next.push(message);
      if (options?.deliverAs === "steer" && options?.triggerTurn) steers.push(message);
    },
  };
  scheduler(pi as any, { warmWake: { thresholdMs: 0 } });
  const ctx = { sessionManager: { getSessionId: () => "p", getBranch: () => [] }, isIdle: () => true };
  const emit = async (name: string) => { for (const h of handlers.get(name) ?? []) await h({}, ctx); };
  const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  await emit("session_start");
  await tick();
  expect(steers).toHaveLength(0);
  expect(acks).toEqual([]); // held, unacked: "merged · waiting to reach Kes"

  peer!.write(`${JSON.stringify({ event: { ...held, urgency: "wake", state: "delivered" } })}\n`);
  await tick();
  expect(steers).toHaveLength(1);
  expect(String(steers[0].content)).toContain("<familiar-merge");
  expect(acks).toContain(held.id);

  // Kev's next message has nothing left to carry.
  await emit("input");
  expect(next).toHaveLength(0);
  await emit("session_shutdown");
  server.close();
});
