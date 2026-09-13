import { expect, test, describe, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_CONFIG as CFG,
  decideAction,
  dndActive,
  makeDnd,
  parseDurationMs,
  sanitizeDnd,
  type QueueItem,
} from "./policy.ts";
import {
  drainIncoming,
  ensureDirs,
  enqueueEnvelopeIdempotent,
  getArchivedItem,
  getItem,
  listItems,
  readDnd,
  writeDnd,
  writeJSONAtomic,
  worklistPaths,
} from "./store.ts";

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: "item-1", ts: 1_000, priority: 2, type: "notify", summary: "summary", body: "body", source: "test", ...over,
});

mock.module("typebox", () => ({ Type: {
  Object: (v: unknown) => v, Optional: (v: unknown) => v, Number: (v: unknown) => v,
  String: (v: unknown) => v, Boolean: (v: unknown) => v,
} }));

describe("Do Not Disturb policy", () => {
  test("normal delivery and DND holding are a two-state policy", () => {
    const now = 10_000;
    expect(decideAction(item({ priority: 0 }), { dnd: false, now, idleForMs: 0 }, CFG)).toBe("deliver-steer");
    for (const priority of [0, 1, 2, 3] as const) {
      expect(decideAction(item({ priority }), { dnd: true, now, idleForMs: CFG.lingerDigestMs }, CFG)).toBe("hold");
    }
  });

  test("default is 30 minutes; custom durations use absolute wall-clock expiry", () => {
    const now = 5_000_000;
    expect(makeDnd("user", undefined, now)?.expiresAt).toBe(now + 30 * 60_000);
    expect(makeDnd("user", 75 * 60_000, now)?.expiresAt).toBe(now + 75 * 60_000);
    expect(dndActive(makeDnd("user", undefined, now), now + 30 * 60_000 - 1)).toBe(true);
    expect(dndActive(makeDnd("user", undefined, now), now + 30 * 60_000)).toBe(false);
  });

  test("the authoritative operation caps Familiar, but not user, requests at two hours", () => {
    const now = 5_000_000;
    expect(makeDnd("familiar", 10 * 60 * 60_000, now)?.expiresAt).toBe(now + 2 * 60 * 60_000);
    expect(makeDnd("user", 10 * 60 * 60_000, now)?.expiresAt).toBe(now + 10 * 60 * 60_000);
    expect(sanitizeDnd({ enabled: true, setBy: "familiar", setAt: now, expiresAt: now + 10 * 60 * 60_000 }, now)?.expiresAt).toBe(now + 2 * 60 * 60_000);
  });

  test("duration parser remains compatible", () => {
    expect(parseDurationMs("30m", 100)).toBe(30 * 60_000);
    expect(parseDurationMs("2h", 100)).toBe(2 * 60 * 60_000);
    expect(parseDurationMs("nope", 100)).toBeUndefined();
  });
});

describe("durable state, migration, and dedup", () => {
  test("DND and queued items survive restart; expiry is truthful", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnd-store-"));
    try {
      const P = worklistPaths(dir); ensureDirs(P);
      writeDnd(P, makeDnd("user", 60_000, 10_000));
      enqueueEnvelopeIdempotent(P, { id: "queued", summary: "settlement" }, 10_000);
      expect(readDnd(worklistPaths(dir), 69_999)?.expiresAt).toBe(70_000);
      expect(listItems(worklistPaths(dir)).map((x) => x.id)).toEqual(["queued"]);
      expect(readDnd(worklistPaths(dir), 70_000)).toBeNull();
      expect(listItems(worklistPaths(dir)).map((x) => x.id)).toEqual(["queued"]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("legacy level state migrates once to DND without carrying the hierarchy", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnd-migrate-"));
    try {
      const P = worklistPaths(dir); ensureDirs(P);
      writeJSONAtomic(P.attention, { mode: "protected", override: { level: "protected", expiresAt: 10_000 + 8 * 60 * 60_000 } });
      const migrated = readDnd(P, 10_000);
      expect(migrated?.enabled).toBe(true);
      expect(migrated?.setBy).toBe("familiar");
      expect(migrated?.expiresAt).toBe(10_000 + 2 * 60 * 60_000);
      expect(fs.existsSync(P.dnd)).toBe(true);
      // A later edit of the retired file cannot overwrite canonical state.
      writeJSONAtomic(P.attention, { mode: "auto", override: null });
      expect(readDnd(P, 10_000)?.enabled).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("available/auto legacy state migrates to DND off", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnd-migrate-off-"));
    try {
      const P = worklistPaths(dir); ensureDirs(P);
      writeJSONAtomic(P.attention, { mode: "available", override: { level: "available", expiresAt: 99_000 } });
      expect(readDnd(P, 10_000)).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("incoming stable ids deduplicate across live and archived history", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnd-dedup-"));
    try {
      const P = worklistPaths(dir); ensureDirs(P);
      writeJSONAtomic(path.join(P.incoming, "first.json"), { id: "stable", summary: "one" });
      expect(drainIncoming(P, 1_000)).toHaveLength(1);
      writeJSONAtomic(path.join(P.incoming, "retry.json"), { id: "stable", summary: "one" });
      expect(drainIncoming(P, 2_000)).toHaveLength(0);
      expect(listItems(P).filter((x) => x.id === "stable")).toHaveLength(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

type Harness = Awaited<ReturnType<typeof runtimeHarness>>;
async function runtimeHarness(existingDir?: string, initialNow = 10_000_000) {
  const dir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "dnd-runtime-"));
  const prior = process.env.FAMILIAR_WORKLIST_DIR;
  let now = initialNow;
  const realNow = Date.now;
  process.env.FAMILIAR_WORKLIST_DIR = dir;
  Date.now = () => now;
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const sent: Array<{ message: any; options: any }> = [];
  const notices: string[] = [];
  const events: Array<{ name: string; value: unknown }> = [];
  const pi = {
    on(name: string, fn: (...args: any[]) => any) { const a = handlers.get(name) ?? []; a.push(fn); handlers.set(name, a); },
    events: { on() {}, emit(name: string, value: unknown) { events.push({ name, value }); } },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    registerTool(def: any) { tools.set(def.name, def); },
    sendMessage(message: any, options: any) { sent.push({ message, options }); },
  };
  const ctx = { hasUI: true, ui: { setStatus() {}, setWidget() {}, notify(text: string) { notices.push(text); } } };
  const mod = await import(`./index.ts?dnd-test=${Math.random()}`);
  const runtime = mod.default(pi as any);
  await handlers.get("session_start")?.[0]?.({}, ctx);
  return {
    dir, runtime, handlers, commands, tools, sent, notices, events, ctx,
    now: () => now, advance: (ms: number) => { now += ms; },
    async close(remove = !existingDir) {
      await handlers.get("session_shutdown")?.[0]?.({});
      Date.now = realNow;
      if (prior === undefined) delete process.env.FAMILIAR_WORKLIST_DIR; else process.env.FAMILIAR_WORKLIST_DIR = prior;
      if (remove) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("runtime DND contract", () => {
  test("fresh user turns remain untouched while every synthetic surface stays queued", async () => {
    const h = await runtimeHarness();
    try {
      await h.tools.get("set_attention").execute("dnd", { enabled: true });
      h.runtime.enqueue({ id: "held-p0", priority: 0, summary: "urgent synthetic", body: "body" });
      h.runtime.enqueue({ id: "held-p1", priority: 1, summary: "settlement", body: "result" });
      h.runtime.tick();
      expect(h.sent).toHaveLength(0);
      expect(await h.handlers.get("before_agent_start")![0]()).toBeUndefined();
      // The input hook observes UI only: it does not consume, delay, clear, or extend the user turn.
      expect(await h.handlers.get("input")![0]({ text: "real user turn" }, h.ctx)).toBeUndefined();
      expect(h.runtime.isDnd()).toBe(true);
      expect(h.sent).toHaveLength(0);
      expect(listItems(worklistPaths(h.dir)).map((x) => x.id).sort()).toEqual(["held-p0", "held-p1"]);
    } finally { await h.close(); }
  });

  test("default expiry resumes paced delivery without duplicates or a herd", async () => {
    const h = await runtimeHarness();
    try {
      const on = await h.tools.get("set_attention").execute("on", { enabled: true });
      expect(on.details.minutes).toBe(30);
      for (const id of ["a", "b", "c"]) h.runtime.enqueue({ id, priority: 0, summary: id, body: id });
      h.advance(30 * 60_000);
      h.runtime.tick();
      expect(h.sent).toHaveLength(1);
      h.runtime.tick(); expect(h.sent).toHaveLength(2);
      h.runtime.tick(); expect(h.sent).toHaveLength(3);
      h.runtime.tick(); expect(h.sent).toHaveLength(3);
      expect(new Set(h.sent.map((s) => s.message.content.match(/id="([^"]+)/)?.[1])).size).toBe(3);
      expect(listItems(worklistPaths(h.dir))).toHaveLength(0);
    } finally { await h.close(); }
  });

  test("custom duration and hard Familiar cap are enforced by execute, not copy", async () => {
    const h = await runtimeHarness();
    try {
      const custom = await h.tools.get("set_attention").execute("custom", { enabled: true, duration_minutes: 45 });
      expect(custom.details.minutes).toBe(45);
      const capped = await h.tools.get("set_attention").execute("cap", { enabled: true, duration_minutes: 600 });
      expect(capped.details.minutes).toBe(120);
      expect(readDnd(worklistPaths(h.dir), h.now())?.expiresAt).toBe(h.now() + 120 * 60_000);
    } finally { await h.close(); }
  });

  test("the fixed UI seam reads durable state and applies only the 30m user toggle", async () => {
    const h = await runtimeHarness();
    const key = Symbol.for("familiar.worklist.dnd.v1");
    try {
      const service = (process as any)[key];
      expect(service?.read()).toEqual({ enabled: false });
      expect(service.set(true)).toEqual({ enabled: true, expiresAt: h.now() + 30 * 60_000 });
      expect(readDnd(worklistPaths(h.dir), h.now())).toMatchObject({ enabled: true, setBy: "user", expiresAt: h.now() + 30 * 60_000 });
      expect(h.events.at(-1)).toEqual({ name: "familiar:worklist-dnd-changed", value: { enabled: true, expiresAt: h.now() + 30 * 60_000 } });
      h.advance(30 * 60_000);
      expect(service.read()).toEqual({ enabled: false });
      expect(readDnd(worklistPaths(h.dir), h.now())).toBeNull();
      expect(service.set(false)).toEqual({ enabled: false });
    } finally {
      await h.close();
      expect((process as any)[key]).toBeUndefined();
    }
  });

  test("Familiar and user can both clear immediately", async () => {
    const h = await runtimeHarness();
    try {
      await h.tools.get("set_attention").execute("on", { enabled: true });
      expect((await h.tools.get("set_attention").execute("off", { enabled: false })).details.enabled).toBe(false);
      expect(h.runtime.isDnd()).toBe(false);
      await h.commands.get("dnd").handler("1h", h.ctx);
      expect(h.runtime.isDnd()).toBe(true);
      await h.commands.get("dnd").handler("off", h.ctx);
      expect(h.runtime.isDnd()).toBe(false);
    } finally { await h.close(); }
  });

  test("legacy set_attention calls map to the toggle while Kes sees only DND copy", async () => {
    const h = await runtimeHarness();
    try {
      const tool = h.tools.get("set_attention");
      const copy = [tool.label, tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join(" ");
      expect(copy).toContain("Do Not Disturb");
      for (const retired of ["open", "available", "focused", "protected", "hierarchy"]) expect(copy.toLowerCase()).not.toContain(retired);
      await tool.execute("old-on", { level: "focused", duration_minutes: 10 });
      expect(h.runtime.isDnd()).toBe(true);
      await tool.execute("old-off", { level: "auto" });
      expect(h.runtime.isDnd()).toBe(false);
      await tool.execute("old-on-again", { level: "protected", duration_minutes: 10 });
      await tool.execute("old-available", { level: "available", duration_minutes: 10 });
      expect(h.runtime.isDnd()).toBe(false);
    } finally { await h.close(); }
  });

  test("restart preserves remaining DND and durable queue, then injects once after expiry", async () => {
    const h1 = await runtimeHarness();
    const dir = h1.dir;
    try {
      await h1.tools.get("set_attention").execute("on", { enabled: true, duration_minutes: 1 });
      h1.runtime.enqueue({ id: "restart-item", priority: 0, summary: "done", body: "verdict" });
      h1.advance(30_000);
      await h1.close(false);
      const h2 = await runtimeHarness(dir, 10_030_000);
      try {
        expect(h2.runtime.isDnd()).toBe(true);
        h2.advance(30_000);
        h2.runtime.tick();
        expect(h2.sent).toHaveLength(1);
        h2.runtime.tick(); expect(h2.sent).toHaveLength(1);
        expect(getItem(worklistPaths(dir), "restart-item")).toBeNull();
        expect(getArchivedItem(worklistPaths(dir), "restart-item")?.acked).toBe(true);
      } finally { await h2.close(false); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
