/* ============================================================================
 * Inbox tests — headless, no pi runtime required.
 * Run with:  nix develop .#stt -c bun test extensions/inbox/inbox.test.ts
 *   (bun is available in the .#stt dev shell; there is no node in .#pi)
 * ============================================================================
 */
import { expect, test, describe, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_CONFIG as CFG,
  decideAction,
  demote,
  promote,
  inferPosture,
  resolveTier,
  shouldEscalate,
  type QueueItem,
  type Priority,
} from "./policy.ts";
import {
  drainIncoming,
  ensureDirs,
  envelopeToItem,
  inboxPaths,
  listItems,
  putItem,
  archiveItem,
  writeJSONAtomic,
  readJSON,
} from "./store.ts";
import { parseWhen } from "./index.ts";

const mkItem = (p: Priority, over: Partial<QueueItem> = {}): QueueItem => ({
  id: `t-${p}-${Math.random().toString(36).slice(2, 6)}`,
  ts: Date.now(),
  priority: p,
  type: "notify",
  summary: `sum-${p}`,
  body: `body-${p}`,
  source: "test",
  ...over,
});

describe("tier arithmetic", () => {
  test("demote clamps at linger", () => {
    expect(demote("steer")).toBe("nudge");
    expect(demote("nudge")).toBe("wait");
    expect(demote("wait")).toBe("linger");
    expect(demote("linger")).toBe("linger");
  });
  test("promote clamps at steer", () => {
    expect(promote("linger")).toBe("wait");
    expect(promote("steer")).toBe("steer");
  });
});

describe("resolveTier: priority × posture matrix", () => {
  test("available posture uses base mapping", () => {
    expect(resolveTier(mkItem(0), "available", CFG)).toBe("steer");
    expect(resolveTier(mkItem(1), "available", CFG)).toBe("nudge");
    expect(resolveTier(mkItem(2), "available", CFG)).toBe("wait");
    expect(resolveTier(mkItem(3), "available", CFG)).toBe("linger");
  });
  test("busy posture demotes all except P0", () => {
    expect(resolveTier(mkItem(0), "busy", CFG)).toBe("steer"); // P0 protected
    expect(resolveTier(mkItem(1), "busy", CFG)).toBe("wait"); // nudge→wait
    expect(resolveTier(mkItem(2), "busy", CFG)).toBe("linger"); // wait→linger
    expect(resolveTier(mkItem(3), "busy", CFG)).toBe("linger"); // clamp
  });
  test("escalation promotes one tier, then busy demotes", () => {
    // P2 escalated → wait promotes to nudge; busy then demotes nudge→wait.
    const it = mkItem(2, { escalated: true });
    expect(resolveTier(it, "available", CFG)).toBe("nudge");
    expect(resolveTier(it, "busy", CFG)).toBe("wait");
  });
});

describe("shouldEscalate", () => {
  const now = 1_000_000;
  test("fires once when deadline passed", () => {
    expect(shouldEscalate(mkItem(2, { suggested_deadline: now - 1 }), now)).toBe(true);
  });
  test("no fire before deadline or when latched", () => {
    expect(shouldEscalate(mkItem(2, { suggested_deadline: now + 1 }), now)).toBe(false);
    expect(shouldEscalate(mkItem(2, { suggested_deadline: now - 1, escalated: true }), now)).toBe(false);
    expect(shouldEscalate(mkItem(2), now)).toBe(false); // no deadline
  });
});

describe("inferPosture", () => {
  const now = 10_000_000;
  test("manual overrides win", () => {
    expect(inferPosture({ mode: "busy", lastActivity: 0, agentBusy: false, now }, CFG)).toBe("busy");
    expect(inferPosture({ mode: "available", lastActivity: now, agentBusy: true, now }, CFG)).toBe("available");
  });
  test("auto: agent working → busy", () => {
    expect(inferPosture({ mode: "auto", lastActivity: 0, agentBusy: true, now }, CFG)).toBe("busy");
  });
  test("auto: recent activity → busy, then settles to available", () => {
    expect(inferPosture({ mode: "auto", lastActivity: now - 1000, agentBusy: false, now }, CFG)).toBe("busy");
    const settled = now - (CFG.settleToAvailableMs + 1);
    expect(inferPosture({ mode: "auto", lastActivity: settled, agentBusy: false, now }, CFG)).toBe("available");
  });
});

describe("decideAction: the delivery ladder", () => {
  const now = 5_000_000;
  test("P0 steers immediately, auto-holds once delivered", () => {
    expect(decideAction(mkItem(0), { posture: "available", now, idleForMs: 0 }, CFG)).toBe("deliver-steer");
    expect(decideAction(mkItem(0, { delivered: true }), { posture: "available", now, idleForMs: 0 }, CFG)).toBe("hold");
  });
  test("P1 available → nudge", () => {
    expect(decideAction(mkItem(1), { posture: "available", now, idleForMs: 0 }, CFG)).toBe("nudge");
  });
  test("P2 wait: holds until settled, then delivers; busy holds entirely", () => {
    const it = mkItem(2);
    expect(decideAction(it, { posture: "available", now, idleForMs: 0 }, CFG)).toBe("hold");
    expect(decideAction(it, { posture: "available", now, idleForMs: CFG.waitSettleMs }, CFG)).toBe("deliver-wait");
    // busy demotes P2 to linger — never a wait-delivery
    expect(decideAction(it, { posture: "busy", now, idleForMs: CFG.waitSettleMs }, CFG)).toBe("hold");
  });
  test("P3 linger: digest only after sustained idle, never in busy", () => {
    const it = mkItem(3);
    expect(decideAction(it, { posture: "available", now, idleForMs: 0 }, CFG)).toBe("hold");
    expect(decideAction(it, { posture: "available", now, idleForMs: CFG.lingerDigestMs }, CFG)).toBe("digest");
    expect(decideAction(it, { posture: "busy", now, idleForMs: CFG.lingerDigestMs }, CFG)).toBe("hold");
    expect(decideAction(mkItem(3, { digested: true }), { posture: "available", now, idleForMs: CFG.lingerDigestMs }, CFG)).toBe("hold");
  });
  test("acked and snoozed items hold", () => {
    expect(decideAction(mkItem(0, { acked: true }), { posture: "available", now, idleForMs: 0 }, CFG)).toBe("hold");
    expect(decideAction(mkItem(0, { snoozedUntil: now + 1000 }), { posture: "available", now, idleForMs: 0 }, CFG)).toBe("hold");
    // snooze expired → back to steer
    expect(decideAction(mkItem(0, { snoozedUntil: now - 1000 }), { posture: "available", now, idleForMs: 0 }, CFG)).toBe("deliver-steer");
  });
  test("escalated P2 in available becomes nudge (was wait)", () => {
    expect(decideAction(mkItem(2, { escalated: true }), { posture: "available", now, idleForMs: 0 }, CFG)).toBe("nudge");
  });
});

describe("store: persistence + atomic + drain", () => {
  let dir: string;
  let P: ReturnType<typeof inboxPaths>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-test-"));
    P = inboxPaths(dir);
    ensureDirs(P);
  });

  test("put/list/archive round-trips and survives 'restart'", () => {
    const a = envelopeToItem({ summary: "one", priority: 1 });
    const b = envelopeToItem({ summary: "two", priority: 3 });
    putItem(P, a);
    putItem(P, b);
    // Fresh paths object = simulated restart reading from disk.
    const reread = listItems(inboxPaths(dir));
    expect(reread.length).toBe(2);
    archiveItem(P, a.id);
    expect(listItems(P).length).toBe(1);
    expect(readJSON(path.join(P.archive, `${a.id}.json`))).toBeTruthy();
  });

  test("drainIncoming promotes envelopes and is idempotent", () => {
    writeJSONAtomic(path.join(P.incoming, "m1.json"), { summary: "from cron", priority: 0, source: "cron" });
    writeJSONAtomic(path.join(P.incoming, "m2.json"), { summary: "no prio" });
    const created = drainIncoming(P);
    expect(created.length).toBe(2);
    expect(created.find((c) => c.source === "cron")?.priority).toBe(0);
    expect(created.find((c) => c.summary === "no prio")?.priority).toBe(2); // default
    // Second drain finds nothing (markers consumed).
    expect(drainIncoming(P).length).toBe(0);
    expect(listItems(P).length).toBe(2);
  });

  test("malformed envelope is skipped, not fatal", () => {
    fs.writeFileSync(path.join(P.incoming, "bad.json"), "{not json");
    writeJSONAtomic(path.join(P.incoming, "ok.json"), { summary: "good" });
    const created = drainIncoming(P);
    expect(created.length).toBe(1);
  });

  test("torn item file does not break listing", () => {
    fs.writeFileSync(path.join(P.items, "torn.json"), "{half");
    putItem(P, envelopeToItem({ summary: "intact" }));
    expect(listItems(P).length).toBe(1);
  });
});

describe("parseWhen", () => {
  const now = 1_000_000_000;
  test("durations", () => {
    expect(parseWhen("30m", now)).toBe(now + 30 * 60_000);
    expect(parseWhen("2h", now)).toBe(now + 2 * 3600_000);
    expect(parseWhen("45s", now)).toBe(now + 45 * 1000);
    expect(parseWhen("1d", now)).toBe(now + 86400_000);
    expect(parseWhen("15", now)).toBe(now + 15 * 60_000); // bare number = minutes
  });
  test("absolute ISO time", () => {
    expect(parseWhen("2026-08-20T15:00:00Z", now)).toBe(Date.parse("2026-08-20T15:00:00Z"));
  });
  test("garbage → undefined", () => {
    expect(parseWhen("banana", now)).toBeUndefined();
  });
});
