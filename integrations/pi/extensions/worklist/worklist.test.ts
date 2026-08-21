/* ============================================================================
 * Worklist tests — headless, no pi runtime required.
 * Run with:  nix develop .#stt -c bun test integrations/pi/extensions/worklist/worklist.test.ts
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
  resolveAttention,
  resolveTier,
  shouldEscalate,
  clampDuration,
  makeOverride,
  overrideExpired,
  parseWhen,
  parseDurationMs,
  type Attention,
  type QueueItem,
  type Priority,
} from "./policy.ts";
import {
  drainIncoming,
  ensureDirs,
  envelopeToItem,
  worklistPaths,
  listItems,
  putItem,
  getArchivedItem,
  getItem,
  archiveItem,
  writeJSONAtomic,
  readJSON,
  readAttention,
  writeAttention,
  itemExists,
  enqueueEnvelopeIdempotent,
  isValidItemId,
} from "./store.ts";

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

describe("resolveTier: priority × attention matrix", () => {
  test("available uses base mapping", () => {
    expect(resolveTier(mkItem(0), "available", CFG)).toBe("steer");
    expect(resolveTier(mkItem(1), "available", CFG)).toBe("nudge");
    expect(resolveTier(mkItem(2), "available", CFG)).toBe("wait");
    expect(resolveTier(mkItem(3), "available", CFG)).toBe("linger");
  });
  test("open promotes all except P0 (already steer)", () => {
    expect(resolveTier(mkItem(0), "open", CFG)).toBe("steer"); // P0 stays
    expect(resolveTier(mkItem(1), "open", CFG)).toBe("steer"); // nudge→steer
    expect(resolveTier(mkItem(2), "open", CFG)).toBe("nudge"); // wait→nudge
    expect(resolveTier(mkItem(3), "open", CFG)).toBe("wait"); // linger→wait
  });
  test("focused demotes all except P0", () => {
    expect(resolveTier(mkItem(0), "focused", CFG)).toBe("steer"); // P0 protected
    expect(resolveTier(mkItem(1), "focused", CFG)).toBe("wait"); // nudge→wait
    expect(resolveTier(mkItem(2), "focused", CFG)).toBe("linger"); // wait→linger
    expect(resolveTier(mkItem(3), "focused", CFG)).toBe("linger"); // clamp
  });
  test("escalation promotes one tier, then focused demotes", () => {
    const it = mkItem(2, { escalated: true });
    expect(resolveTier(it, "available", CFG)).toBe("nudge");
    expect(resolveTier(it, "focused", CFG)).toBe("wait");
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

describe("resolveAttention: inference + override", () => {
  const now = 10_000_000;
  test("live override wins outright", () => {
    expect(resolveAttention({ override: { level: "protected", expiresAt: now + 1000 }, lastActivity: now, agentBusy: true, now }, CFG)).toBe("protected");
    expect(resolveAttention({ override: { level: "available", expiresAt: now + 1000 }, lastActivity: now, agentBusy: true, now }, CFG)).toBe("available");
  });
  test("expired override falls straight through to inference (no decay)", () => {
    // override expired at now → agent working → focused
    expect(resolveAttention({ override: { level: "protected", expiresAt: now - 1 }, lastActivity: now, agentBusy: true, now }, CFG)).toBe("focused");
  });
  test("auto: agent working → focused", () => {
    expect(resolveAttention({ lastActivity: 0, agentBusy: true, now }, CFG)).toBe("focused");
  });
  test("auto: recent activity → focused; then available; then open", () => {
    expect(resolveAttention({ lastActivity: now - 1000, agentBusy: false, now }, CFG)).toBe("focused");
    const avail = now - (CFG.settleToAvailableMs + 1);
    expect(resolveAttention({ lastActivity: avail, agentBusy: false, now }, CFG)).toBe("available");
    const open = now - (CFG.settleToOpenMs + 1);
    expect(resolveAttention({ lastActivity: open, agentBusy: false, now }, CFG)).toBe("open");
  });
  test("attention only ever takes the four named values", () => {
    const valid: Attention[] = ["open", "available", "focused", "protected"];
    for (const t of [-1, 0, 1000, CFG.settleToAvailableMs + 1, CFG.settleToOpenMs + 1]) {
      const a = resolveAttention({ lastActivity: now - t, agentBusy: false, now }, CFG);
      expect(valid).toContain(a);
    }
  });
});

describe("override duration clamp + build", () => {
  const now = 5_000_000;
  test("clampDuration rejects non-positive/NaN, caps at ceiling", () => {
    expect(clampDuration(-1, CFG)).toBeNull();
    expect(clampDuration(0, CFG)).toBeNull();
    expect(clampDuration(NaN, CFG)).toBeNull();
    expect(clampDuration(30 * 60_000, CFG)).toBe(30 * 60_000);
    expect(clampDuration(CFG.maxOverrideMs + 1, CFG)).toBe(CFG.maxOverrideMs);
    expect(clampDuration(300 * 3600_000, CFG)).toBe(CFG.maxOverrideMs); // /protect 300h
  });
  test("makeOverride produces wall-clock expiry, clamped", () => {
    const ov = makeOverride("protected", 30 * 60_000, now, CFG);
    expect(ov).toEqual({ level: "protected", expiresAt: now + 30 * 60_000 });
    const capped = makeOverride("protected", 100 * 3600_000, now, CFG);
    expect(capped?.expiresAt).toBe(now + CFG.maxOverrideMs);
    expect(makeOverride("protected", 0, now, CFG)).toBeNull();
  });
  test("overrideExpired boundary", () => {
    expect(overrideExpired({ level: "protected", expiresAt: now }, now)).toBe(true); // >= expiry
    expect(overrideExpired({ level: "protected", expiresAt: now + 1 }, now)).toBe(false);
    expect(overrideExpired(null, now)).toBe(true);
  });
});

describe("decideAction: full policy matrix (4 attention × 4 priority)", () => {
  const now = 5_000_000;
  const act = (p: Priority, a: Attention, idle = 0, over: Partial<QueueItem> = {}) =>
    decideAction(mkItem(p, over), { attention: a, now, idleForMs: idle }, CFG);

  test("protected holds EVERY priority incl. P0", () => {
    expect(act(0, "protected")).toBe("hold");
    expect(act(1, "protected")).toBe("hold");
    expect(act(2, "protected", CFG.waitSettleMs)).toBe("hold");
    expect(act(3, "protected", CFG.lingerDigestMs)).toBe("hold");
    // even escalated P0 during protected holds
    expect(act(0, "protected", 0, { escalated: true })).toBe("hold");
  });
  test("P0 steers under open/available/focused; holds once delivered", () => {
    expect(act(0, "open")).toBe("deliver-steer");
    expect(act(0, "available")).toBe("deliver-steer");
    expect(act(0, "focused")).toBe("deliver-steer");
    expect(act(0, "available", 0, { delivered: true })).toBe("hold");
  });
  test("open pulls work forward: P1 steers, P2 nudges, P3 waits-then-delivers", () => {
    expect(act(1, "open")).toBe("deliver-steer");
    expect(act(2, "open")).toBe("nudge");
    expect(act(3, "open", 0)).toBe("hold");
    expect(act(3, "open", CFG.waitSettleMs)).toBe("deliver-wait"); // linger→wait under open
  });
  test("available base ladder", () => {
    expect(act(1, "available")).toBe("nudge");
    expect(act(2, "available", 0)).toBe("hold");
    expect(act(2, "available", CFG.waitSettleMs)).toBe("deliver-wait");
    expect(act(3, "available", 0)).toBe("hold");
    expect(act(3, "available", CFG.lingerDigestMs)).toBe("digest");
  });
  test("focused suppresses ordinary interruptions (wait/linger hold entirely)", () => {
    expect(act(1, "focused")).toBe("hold"); // nudge→wait, focused holds wait
    expect(act(2, "focused", CFG.waitSettleMs)).toBe("hold"); // →linger, focused holds
    expect(act(3, "focused", CFG.lingerDigestMs)).toBe("hold");
  });
  test("acked / withdrawn / snoozed items hold", () => {
    expect(act(0, "available", 0, { acked: true })).toBe("hold");
    expect(act(0, "available", 0, { withdrawn: true })).toBe("hold");
    expect(act(0, "available", 0, { snoozedUntil: now + 1000 })).toBe("hold");
    expect(act(0, "available", 0, { snoozedUntil: now - 1000 })).toBe("deliver-steer"); // expired snooze
  });
});

describe("store: persistence + atomic + drain + migration", () => {
  let dir: string;
  let P: ReturnType<typeof worklistPaths>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "worklist-test-"));
    P = worklistPaths(dir);
    ensureDirs(P);
  });

  test("put/list/archive round-trips and survives 'restart'", () => {
    const a = envelopeToItem({ summary: "one", priority: 1 });
    const b = envelopeToItem({ summary: "two", priority: 3 });
    putItem(P, a);
    putItem(P, b);
    const reread = listItems(worklistPaths(dir)); // simulated restart
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
    expect(created.find((c) => c.summary === "no prio")?.priority).toBe(2);
    expect(drainIncoming(P).length).toBe(0);
    expect(listItems(P).length).toBe(2);
  });

  test("drainIncoming dedups on stable id (no double-enqueue)", () => {
    const item = envelopeToItem({ summary: "settle", id: "sub-x-1" });
    putItem(P, item);
    writeJSONAtomic(path.join(P.incoming, "again.json"), { summary: "settle", id: "sub-x-1" });
    const created = drainIncoming(P);
    expect(created.length).toBe(0); // already exists
    expect(itemExists(P, "sub-x-1")).toBe(true);
  });

  test("malformed / torn claims are retained, not fatal or silently lost", () => {
    fs.writeFileSync(path.join(P.incoming, "bad.json"), "{not json");
    writeJSONAtomic(path.join(P.incoming, "ok.json"), { summary: "good" });
    expect(drainIncoming(P).length).toBe(1);
    expect(fs.existsSync(path.join(P.incoming, "bad.json.claimed"))).toBe(true);
    fs.writeFileSync(path.join(P.items, "torn.json"), "{half");
    putItem(P, envelopeToItem({ summary: "intact" }));
    expect(listItems(P).filter((i) => i.summary === "intact").length).toBe(1);
  });

  test("restart recovers claims at every promotion boundary", () => {
    // Death immediately after claim rename.
    writeJSONAtomic(path.join(P.incoming, "claimed.json.claimed"), { summary: "recover claim", id: "claim-1" });
    expect(drainIncoming(P).map((i) => i.id)).toEqual(["claim-1"]);
    expect(fs.existsSync(path.join(P.incoming, "claimed.json.claimed"))).toBe(false);

    // Death after durable put but before claim cleanup: restart dedupes then cleans.
    putItem(P, envelopeToItem({ summary: "already promoted", id: "claim-2" }));
    writeJSONAtomic(path.join(P.incoming, "put.json.claimed"), { summary: "already promoted", id: "claim-2" });
    expect(drainIncoming(P).length).toBe(0);
    expect(fs.existsSync(path.join(P.incoming, "put.json.claimed"))).toBe(false);
    expect(listItems(P).filter((i) => i.id === "claim-2").length).toBe(1);
  });

  test("attention persistence: wall-clock override survives restart; expired discarded on read", () => {
    const future = Date.now() + 60_000;
    writeAttention(P, { mode: "protected", override: { level: "protected", expiresAt: future } });
    const back = readAttention(worklistPaths(dir)); // restart
    expect(back.override?.expiresAt).toBe(future);
    expect(back.mode).toBe("protected");
    // A past expiry is still returned by the store (extension discards lazily);
    // resolveAttention/overrideExpired handle the discard.
    writeAttention(P, { mode: "protected", override: { level: "protected", expiresAt: Date.now() - 1 } });
    const stale = readAttention(P);
    expect(overrideExpired(stale.override, Date.now())).toBe(true);
  });

  test("persisted override is validated + clamped on load (never unbounded across restart)", () => {
    const now = Date.now();
    // Far-future expiry (clock rollback / corrupt / older writer): clamp to the
    // 8h ceiling, and persist the normalized state.
    const farFuture = now + 30 * 24 * 60 * 60 * 1000; // 30 days
    writeAttention(P, { mode: "protected", override: { level: "protected", expiresAt: farFuture } });
    const clamped = readAttention(P, now);
    expect(clamped.override).not.toBeNull();
    const ceiling = now + 8 * 60 * 60 * 1000;
    expect(clamped.override!.expiresAt).toBeLessThanOrEqual(ceiling);
    expect(clamped.override!.expiresAt).toBeGreaterThan(now);
    // Normalized state was persisted atomically: a second read is already capped.
    const persisted = readJSON<{ override?: { expiresAt?: number } }>(P.attention);
    expect(persisted?.override?.expiresAt).toBeLessThanOrEqual(ceiling);

    // Corrupt level → dropped to auto inference (no override).
    writeAttention(P, { mode: "protected", override: { level: "bogus" as never, expiresAt: now + 1000 } });
    expect(readAttention(P, now).override).toBeNull();

    // Non-finite expiry → dropped.
    writeJSONAtomic(P.attention, { mode: "protected", override: { level: "protected", expiresAt: "soon" } });
    expect(readAttention(P, now).override).toBeNull();
  });

  test("legacy inbox migration: items + posture adopted, no unbounded busy carried", () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "wl-mig-"));
    const legacy = path.join(fresh, "inbox");
    const wl = path.join(fresh, "worklist");
    fs.mkdirSync(path.join(legacy, "items"), { recursive: true });
    fs.mkdirSync(path.join(legacy, "incoming"), { recursive: true });
    const legacyItem = envelopeToItem({ summary: "legacy queued", id: "legacy-1" });
    fs.writeFileSync(path.join(legacy, "items", "legacy-1.json"), JSON.stringify(legacyItem));
    fs.writeFileSync(path.join(legacy, "posture.json"), JSON.stringify({ mode: "busy" }));
    const WP = worklistPaths(wl);
    // A pre-existing partial destination must not suppress reconciliation.
    ensureDirs(WP);
    ensureDirs(WP, legacy);
    expect(getItem(WP, "legacy-1")?.summary).toBe("legacy queued");
    // legacy permanent "busy" must NOT persist as an unbounded override
    const att = readAttention(WP);
    expect(att.override).toBeNull();
    expect(att.mode).toBe("auto"); // busy→focused pin dropped to auto (no expiry)

    // An old writer appearing after migration is continuously reconciled.
    fs.mkdirSync(path.join(legacy, "incoming"), { recursive: true });
    writeJSONAtomic(path.join(legacy, "incoming", "late.json"), { summary: "late old writer", id: "legacy-late" });
    ensureDirs(WP, legacy);
    expect(getItem(WP, "legacy-late")?.summary).toBe("late old writer");
    expect(fs.existsSync(path.join(legacy, "incoming", "late.json.claimed"))).toBe(false);
  });

  test("untrusted ids cannot escape live/archive/incoming/migration paths", () => {
    const escaped = path.join(path.dirname(P.root), "escaped.json");
    const bad = "../../escaped";
    expect(isValidItemId(bad)).toBe(false);
    expect(() => enqueueEnvelopeIdempotent(P, { id: bad, summary: "attack" })).toThrow();
    expect(getItem(P, bad)).toBeNull();
    expect(getArchivedItem(P, bad)).toBeNull();
    archiveItem(P, bad); // withdraw/archive-style lookup is a no-op, never traversal
    expect(fs.existsSync(escaped)).toBe(false);

    writeJSONAtomic(path.join(P.incoming, "attack.json"), { id: bad, summary: "incoming attack" });
    expect(drainIncoming(P)).toEqual([]);
    expect(fs.existsSync(path.join(P.incoming, "attack.json.claimed"))).toBe(true);
    expect(fs.existsSync(escaped)).toBe(false);

    const legacy = path.join(path.dirname(P.root), "legacy-traversal");
    fs.mkdirSync(path.join(legacy, "items", "archive"), { recursive: true });
    writeJSONAtomic(path.join(legacy, "items", "attack.json"), mkItem(1, { id: bad, summary: "legacy attack" }));
    writeJSONAtomic(path.join(legacy, "items", "archive", "attack-archive.json"), mkItem(1, { id: bad, summary: "legacy archive attack" }));
    ensureDirs(P, legacy);
    expect(fs.existsSync(escaped)).toBe(false);
    const quarantined = fs.readdirSync(path.join(P.root, "migration-conflicts"));
    expect(quarantined.some((n) => n.startsWith("invalid-live-attack"))).toBe(true);
    expect(quarantined.some((n) => n.startsWith("invalid-archive-attack-archive"))).toBe(true);
  });

  test("partial migration is idempotent, archive-aware, and preserves conflicts", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wl-partial-"));
    const legacy = path.join(base, "inbox");
    const WP = worklistPaths(path.join(base, "worklist"));
    fs.mkdirSync(path.join(legacy, "items"), { recursive: true });
    ensureDirs(WP);
    const terminal = envelopeToItem({ id: "same", summary: "new terminal" });
    terminal.acked = terminal.delivered = true;
    putItem(WP, terminal);
    archiveItem(WP, "same");
    const old = envelopeToItem({ id: "same", summary: "old conflicting copy" });
    writeJSONAtomic(path.join(legacy, "items", "same.json"), old);
    ensureDirs(WP, legacy);
    ensureDirs(WP, legacy); // restart/retry
    expect(getItem(WP, "same")).toBeNull();
    expect(readJSON<QueueItem>(path.join(WP.archive, "same.json"))?.summary).toBe("new terminal");
    expect(readJSON<QueueItem>(path.join(WP.root, "migration-conflicts", "live-same.json"))?.summary).toBe("old conflicting copy");

    // A later, different conflict with the same source name must get its own
    // collision-safe file; neither source may overwrite/delete the other.
    const second = envelopeToItem({ id: "same", summary: "second conflicting copy" });
    writeJSONAtomic(path.join(legacy, "items", "same.json"), second);
    ensureDirs(WP, legacy);
    const conflictFiles = fs.readdirSync(path.join(WP.root, "migration-conflicts")).filter((n) => n.startsWith("live-same"));
    expect(conflictFiles.length).toBe(2);
    const summaries = conflictFiles.map((n) => readJSON<QueueItem>(path.join(WP.root, "migration-conflicts", n))?.summary).sort();
    expect(summaries).toEqual(["old conflicting copy", "second conflicting copy"]);
    expect(fs.existsSync(path.join(legacy, "items", "same.json"))).toBe(false);
  });
});

describe("parseWhen / parseDurationMs", () => {
  const now = 1_000_000_000;
  test("durations", () => {
    expect(parseWhen("30m", now)).toBe(now + 30 * 60_000);
    expect(parseWhen("2h", now)).toBe(now + 2 * 3600_000);
    expect(parseWhen("45s", now)).toBe(now + 45 * 1000);
    expect(parseWhen("1d", now)).toBe(now + 86400_000);
    expect(parseWhen("15", now)).toBe(now + 15 * 60_000);
  });
  test("parseDurationMs returns delta", () => {
    expect(parseDurationMs("30m", now)).toBe(30 * 60_000);
    expect(parseDurationMs("banana", now)).toBeUndefined();
  });
  test("absolute ISO + garbage", () => {
    expect(parseWhen("2026-08-20T15:00:00Z", now)).toBe(Date.parse("2026-08-20T15:00:00Z"));
    expect(parseWhen("banana", now)).toBeUndefined();
  });
});
