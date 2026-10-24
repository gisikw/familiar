import { afterEach, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import scheduler from "./index.ts";

// Regression: a soft (nextTurn) event must be queued once and acked once,
// even when (a) the scheduler reconnects and redelivers it while it waits for
// Kev's next message, and (b) that reply is a single turn, where Pi persists
// the queued message at message_end AFTER turn_start. Before the fix each
// reconnect queued another copy and single-turn replies never acked, so every
// later reconnect re-queued it again: one duplicate per user turn.

const roots: string[] = [];
const savedSocket = process.env.FAMILIAR_SERVICES_SOCKET;
afterEach(() => {
  if (savedSocket === undefined) delete process.env.FAMILIAR_SERVICES_SOCKET; else process.env.FAMILIAR_SERVICES_SOCKET = savedSocket;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const softEvent = { id: "merge-f-abc", due_at: 0, target: "instance:p", origin: "f", source: "imp.merge", priority: 2, type: "merge", summary: "home", body: JSON.stringify({ summary: "home", forkSessionId: "f", forkSessionFile: "/x", branchEntryId: "b", firstEntryId: "1", lastEntryId: "2", turnCount: 2, forkedFurther: false, mergedAt: "" }), urgency: "soft" as const, state: "delivered", created_at: 0 };

test("a soft event redelivered on reconnect is queued once, and a single-turn reply acks it", async () => {
  const root = mkdtempSync(join(tmpdir(), "sched-soft-"));
  roots.push(root);
  const socketPath = join(root, "svc.sock");
  process.env.FAMILIAR_SERVICES_SOCKET = socketPath;
  const acks: string[] = [];
  let hellos = 0;
  const sockets: Socket[] = [];
  const server = createServer((socket: Socket) => {
    sockets.push(socket);
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        // Like familiar-services: every hello requeues unacked events.
        if (msg.op === "hello") { hellos++; socket.write(`${JSON.stringify({ ok: true, result: {} })}\n`); if (!acks.length) socket.write(`${JSON.stringify({ event: softEvent })}\n`); }
        if (msg.op === "schedule.ack") acks.push(msg.args.id);
      }
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));

  const handlers = new Map<string, Array<(e: any, ctx: any) => any>>();
  const entries: any[] = [];
  const queued: any[] = [];
  const pi = {
    on(name: string, h: any) { handlers.set(name, [...(handlers.get(name) ?? []), h]); },
    appendEntry() {},
    sendMessage(message: any, options: any) { if (options?.deliverAs === "nextTurn") queued.push(message); },
  };
  scheduler(pi as any);
  const ctx = { sessionManager: { getSessionId: () => "p", getBranch: () => entries }, isIdle: () => true };
  const emit = async (name: string) => { for (const h of handlers.get(name) ?? []) await h({}, ctx); };
  const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
  await emit("session_start");
  await tick();
  expect(queued).toHaveLength(0); // held until a prompt is about to drain nextTurn

  // familiar-services restarts while the notice waits for Kev: reconnect, redeliver.
  for (const s of sockets.splice(0)) s.destroy();
  await tick(600);
  expect(hellos).toBe(2);
  expect(acks).toEqual([]);

  // Kev replies; input hands the held copy to Pi exactly once.
  await emit("input");
  expect(queued).toHaveLength(1); // no second copy in Pi's nextTurn buffer
  // A single-turn reply: turn_start fires before persistence.
  await emit("turn_start");
  await tick();
  expect(acks).toEqual([]);
  entries.push({ type: "custom_message", customType: "familiar.merge.v1", details: { id: softEvent.id } }); // message_end persistence
  await emit("turn_end");
  await tick();
  expect(acks).toEqual([softEvent.id, softEvent.id]); // both deliveries acked (server tolerates the repeat)

  await emit("session_shutdown");
  await new Promise<void>((r) => server.close(() => r()));
});

// Regression (Oct 24): forks never get the idle prompt that drains held soft
// messages, so every soft sibling note (deploy locks) sat unread until the
// fork merged and was then rerouted to the primary. A busy fork now takes a
// soft note as a steer (no new turn) and acks it once persisted.
test("a busy fork reads a soft note as a steer and acks it", async () => {
  const root = mkdtempSync(join(tmpdir(), "sched-soft-fork-"));
  roots.push(root);
  const socketPath = join(root, "svc.sock");
  process.env.FAMILIAR_SERVICES_SOCKET = socketPath;
  const note = { id: "note-sib-1", due_at: 0, target: "instance:f", origin: "sib", source: "unknown", priority: 2, type: "notify", summary: "deploy lock released", body: "", urgency: "soft" as const, state: "delivered", created_at: 0 };
  const acks: string[] = [];
  const server = createServer((socket: Socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (msg.op === "hello") { socket.write(`${JSON.stringify({ ok: true, result: {} })}\n`); socket.write(`${JSON.stringify({ event: note })}\n`); }
        if (msg.op === "schedule.ack") acks.push(msg.args.id);
      }
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  const handlers = new Map<string, Array<(e: any, ctx: any) => any>>();
  const entries: any[] = [];
  const sent: Array<{ message: any; options: any }> = [];
  const pi = {
    on(name: string, h: any) { handlers.set(name, [...(handlers.get(name) ?? []), h]); },
    appendEntry() {},
    sendMessage(message: any, options: any) { sent.push({ message, options }); },
  };
  scheduler(pi as any, { fork: true });
  const ctx = { sessionManager: { getSessionId: () => "f", getBranch: () => entries }, isIdle: () => false };
  const emit = async (name: string) => { for (const h of handlers.get(name) ?? []) await h({}, ctx); };
  const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
  await emit("session_start");
  await tick();
  expect(sent).toHaveLength(1);
  expect(sent[0].options).toEqual({ deliverAs: "steer" }); // read mid-run, no new turn
  entries.push({ type: "custom_message", customType: sent[0].message.customType, details: sent[0].message.details });
  await emit("turn_end");
  await tick();
  expect(acks).toEqual([note.id]);
  await emit("session_shutdown");
  await new Promise<void>((r) => server.close(() => r()));
});
