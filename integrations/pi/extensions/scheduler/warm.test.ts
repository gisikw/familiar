import { afterEach, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import scheduler, { DISTURB_WAKE, parseDndMode, renderWarmWake, warmWakeConfig, warmWakeDue, WARM_WAKE } from "./index.ts";

// Kev, Oct 11: quiet merges used to wait for his next message. If the primary
// has sat idle ~55 min with returns pending, deliver them in one self-wake turn
// so the 1h prompt cache stays warm. Never mid-turn, never during DND, never
// once the cache is already cold, and never as a duplicate of Pi's nextTurn.

const roots: string[] = [];
const savedSocket = process.env.FAMILIAR_SERVICES_SOCKET;
afterEach(() => {
  if (savedSocket === undefined) delete process.env.FAMILIAR_SERVICES_SOCKET; else process.env.FAMILIAR_SERVICES_SOCKET = savedSocket;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const mergeEvent = (id: string, fork: string) => ({ id, due_at: 0, target: "instance:p", origin: fork, source: "imp.merge", priority: 2, type: "merge", summary: "home", body: JSON.stringify({ summary: `${fork} home`, forkSessionId: fork, forkSessionFile: "/x", branchEntryId: "b", firstEntryId: "1", lastEntryId: "2", turnCount: 2, forkedFurther: false, mergedAt: "" }), urgency: "soft" as const, state: "delivered", created_at: 0 });

test("config: default 55/60, env overrides, 0 disables, garbage falls back", () => {
  expect(warmWakeConfig({}, {})).toEqual({ thresholdMs: 55 * 60_000, ttlMs: 60 * 60_000 });
  expect(warmWakeConfig({}, { FAMILIAR_WARM_WAKE_MINUTES: "40", FAMILIAR_WARM_WAKE_TTL_MINUTES: "50" })).toEqual({ thresholdMs: 40 * 60_000, ttlMs: 50 * 60_000 });
  expect(warmWakeConfig({}, { FAMILIAR_WARM_WAKE_MINUTES: "0" }).thresholdMs).toBe(0);
  expect(warmWakeConfig({}, { FAMILIAR_WARM_WAKE_MINUTES: "soon" }).thresholdMs).toBe(55 * 60_000);
  const c = warmWakeConfig({}, {});
  expect(warmWakeDue(c, 54 * 60_000)).toBe(false);
  expect(warmWakeDue(c, 56 * 60_000)).toBe(true);
  expect(warmWakeDue(c, 61 * 60_000)).toBe(false); // cache already cold: wait for Kev
  expect(warmWakeDue({ thresholdMs: 0, ttlMs: 60 * 60_000 }, 56 * 60_000)).toBe(false);
  expect(renderWarmWake(2, 56 * 60_000).content).toContain("Do not push");
});

async function harness(opts: { dnd?: boolean; disturb?: boolean; idle?: () => boolean; ttlMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sched-warm-"));
  roots.push(root);
  const socketPath = join(root, "svc.sock");
  process.env.FAMILIAR_SERVICES_SOCKET = socketPath;
  const acks: string[] = [];
  const events = [mergeEvent("m-a", "fa"), mergeEvent("m-b", "fb")];
  const server = createServer((socket: Socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (msg.op === "hello") { socket.write(`${JSON.stringify({ ok: true, result: {} })}\n`); for (const e of events) socket.write(`${JSON.stringify({ event: e })}\n`); }
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
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
      // Pi: not streaming and no trigger appends + persists immediately.
      if (!options) entries.push({ type: "custom_message", customType: message.customType, details: message.details });
    },
  };
  scheduler(pi as any, { warmWake: { thresholdMs: 40, ttlMs: opts.ttlMs ?? 5_000, intervalMs: 15, primary: true, dndOn: async () => opts.dnd ?? false, disturbOn: async () => opts.disturb ?? false } });
  const ctx = { sessionManager: { getSessionId: () => "p", getBranch: () => entries }, isIdle: opts.idle ?? (() => true) };
  const emit = async (name: string) => { for (const h of handlers.get(name) ?? []) await h({}, ctx); };
  const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
  const close = async () => { await emit("session_shutdown"); await new Promise<void>((r) => server.close(() => r())); };
  return { acks, sent, emit, tick, close };
}

test("idle past the threshold: one wake delivers every held merge, persisted and acked", async () => {
  const h = await harness();
  await h.emit("session_start");
  await h.tick(250);
  const wakes = h.sent.filter((s) => s.message.customType === WARM_WAKE);
  expect(wakes).toHaveLength(1);
  expect(wakes[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
  const merges = h.sent.filter((s) => s.message.customType === "familiar.merge.v1");
  expect(merges.map((s) => s.options)).toEqual([undefined, undefined]); // appended, not nextTurn
  expect(h.sent.indexOf(merges[1])).toBeLessThan(h.sent.indexOf(wakes[0]));
  await h.emit("turn_start");
  await h.tick();
  expect(h.acks.sort()).toEqual(["m-a", "m-b"]);
  // Kev's next message finds nothing left to hand Pi: no duplicate.
  const before = h.sent.length;
  await h.emit("input");
  expect(h.sent.length).toBe(before);
  await h.close();
});

test("DND on: no wake, merges stay held for Kev's next message", async () => {
  const h = await harness({ dnd: true });
  await h.emit("session_start");
  await h.tick(250);
  expect(h.sent.filter((s) => s.message.customType === WARM_WAKE)).toHaveLength(0);
  await h.emit("input");
  expect(h.sent.filter((s) => s.options?.deliverAs === "nextTurn")).toHaveLength(2);
  await h.close();
});

test("a running turn: no wake", async () => {
  const h = await harness({ idle: () => false });
  await h.emit("session_start");
  await h.tick(250);
  expect(h.sent.filter((s) => s.message.customType === WARM_WAKE)).toHaveLength(0);
  await h.close();
});

test("cache already cold (past TTL): no wake", async () => {
  const h = await harness({ ttlMs: 40 });
  await h.emit("session_start");
  await h.tick(250);
  expect(h.sent.filter((s) => s.message.customType === WARM_WAKE)).toHaveLength(0);
  await h.close();
});

// Kev, Oct 24: on busy Saturdays, "do disturb" means quiet returns wake me.
// familiar-services claims new ones as wakes; merges already held from before
// it was switched on are delivered as soon as the primary is idle, no 55m wait.
test("Do Disturb: held merges wake the primary at once, without the warm-wake note", async () => {
  const h = await harness({ disturb: true });
  await h.emit("session_start");
  await h.tick(100);
  expect(h.sent.filter((s) => s.message.customType === WARM_WAKE)).toHaveLength(0);
  const merges = h.sent.filter((s) => s.message.customType === "familiar.merge.v1");
  expect(merges.map((s) => s.options)).toEqual([undefined, undefined]);
  const nudge = h.sent.filter((s) => s.message.customType === DISTURB_WAKE);
  expect(nudge.map((s) => s.options)).toEqual([{ deliverAs: "steer", triggerTurn: true }]);
  await h.emit("turn_start");
  await h.tick();
  expect(h.acks.sort()).toEqual(["m-a", "m-b"]);
  await h.close();
});

test("parseDndMode: off, quiet, disturb, expired, garbage counts as quiet", () => {
  expect(parseDndMode("null")).toBe("off");
  expect(parseDndMode(JSON.stringify({ enabled: true, expiresAt: 2_000, mode: "quiet" }), 1_000)).toBe("quiet");
  expect(parseDndMode(JSON.stringify({ enabled: true, expiresAt: 2_000 }), 1_000)).toBe("quiet");
  expect(parseDndMode(JSON.stringify({ enabled: true, expiresAt: 2_000, mode: "disturb" }), 1_000)).toBe("disturb");
  expect(parseDndMode(JSON.stringify({ enabled: true, expiresAt: 500, mode: "disturb" }), 1_000)).toBe("off");
  expect(parseDndMode("{oops")).toBe("quiet");
});
