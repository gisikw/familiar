/* Integration-style tests for the settlement relay's DURABLE DROP-BOX fallback,
 * exercised against the REAL worklist store (drainIncoming/listItems). These
 * cover the live loader-isolation failure: pi's extension loader can hand the
 * external contrib plugin and the built-in worklist extension separate module
 * instances, so the process-local capability registry singleton does not cross
 * that boundary and resolveSink() stays undefined. The relay must then fall back
 * to worklist's official incoming/ drop-box (PROTOCOL.md §Enqueue paths (b)). */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, chmodSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SettlementRelay, type JobDetail, type RelayClient } from "./relay.ts";
import {
  ensureDirs,
  drainAcknowledgements,
  drainIncoming,
  listItems,
  worklistPaths,
} from "../../../../integrations/pi/extensions/worklist/store.ts";
import type { DurableSink, DurableEnqueueEnvelope, DurableAcceptance } from "../../../../integrations/pi/extensions/lib/capabilities.ts";

function fakeClient() {
  const jobs = new Map<string, JobDetail>();
  const client: RelayClient = {
    async status(id) { const j = jobs.get(id); if (!j) throw new Error(`no job ${id}`); return j; },
    async list() { return [...jobs.values()]; },
    async streamEvents(_since, _onEvent, signal) {
      await new Promise<void>((r) => { const t = setTimeout(r, 15); signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
    },
  };
  return { client, jobs };
}

const settled = (id: string, state = "done", verdict = "ok"): JobDetail => ({
  id, state, harness: "pi", model: "op/m", workspace: { project: "familiar", worktree: "wt" },
  settlement: { state, verdict, artifacts: [{ path: "out.txt", size: 3 }], usage: { input_tokens: 5 } },
});

let dirs: string[] = [];
function newDir(): string { const d = mkdtempSync(path.join(tmpdir(), "relay-wl-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs) { try { chmodSync(path.join(d, "worklist", "incoming"), 0o700); } catch {} rmSync(d, { recursive: true, force: true }); } dirs = []; });

describe("settlement relay ↔ real worklist drop-box (loader-isolation fallback)", () => {
  test("registry unavailable → dropbox file → real drain → exactly one worklist item", async () => {
    const base = newDir();
    const wlRoot = path.join(base, "worklist");
    const P = worklistPaths(wlRoot);
    ensureDirs(P); // worklist owns creating its tree (incoming/ + items/)

    const { client, jobs } = fakeClient();
    jobs.set("job-591754", settled("job-591754", "done", "shipped"));
    // resolveSink returns undefined — the live loader-isolation symptom.
    const relay = new SettlementRelay({
      client, stateDir: path.join(base, "golem-settlement"),
      dropboxDir: P.incoming, resolveSink: () => undefined, backoffMs: 1,
    });
    await relay.recordDispatch("job-591754");
    await relay.stop();

    // A durable envelope now sits in worklist's incoming dir.
    const drops = readdirSync(P.incoming).filter((n) => n.endsWith(".json"));
    expect(drops.length).toBe(1);
    // The relay committed done + cleared pending on the atomic rename.
    expect(existsSync(path.join(base, "golem-settlement", "done", "job-591754.json"))).toBe(true);
    expect(readdirSync(path.join(base, "golem-settlement", "pending")).length).toBe(0);

    // The REAL worklist drain promotes it to exactly one item with our stable id.
    const created = drainIncoming(P);
    expect(created.length).toBe(1);
    expect(created[0].id).toBe("golem-settle-job-591754");
    expect(created[0].source).toBe("golem");
    expect(created[0].body).toContain("shipped");
    const items = listItems(P);
    expect(items.map((i) => i.id)).toEqual(["golem-settle-job-591754"]);
  });

  test("foreground receipt resolves a dropbox-promoted item across loader isolation", async () => {
    const base = newDir();
    const P = worklistPaths(path.join(base, "worklist"));
    ensureDirs(P);
    const { client, jobs } = fakeClient();
    jobs.set("opened", settled("opened"));
    const relay = new SettlementRelay({ client, stateDir: path.join(base, "golem-settlement"), dropboxDir: P.incoming, resolveSink: () => undefined });
    await relay.recordDispatch("opened");
    expect(drainIncoming(P).map((item) => item.id)).toEqual(["golem-settle-opened"]);

    // Equivalent to agents_status({id:"opened"}) having returned the terminal
    // detail: it writes an acknowledgement request keyed by the same stable id.
    await relay.acknowledgeSettlement("opened");
    expect(listItems(P).map((item) => item.id)).toEqual(["golem-settle-opened"]);
    expect(drainAcknowledgements(P)).toEqual(["golem-settle-opened"]);
    expect(listItems(P)).toEqual([]);
    const archived = JSON.parse(readFileSync(path.join(P.archive, "golem-settle-opened.json"), "utf8"));
    expect(archived.acked).toBe(true);
  });

  test("duplicate/restart via dropbox remains a single item (stable-id dedup)", async () => {
    const base = newDir();
    const P = worklistPaths(path.join(base, "worklist"));
    ensureDirs(P);
    const stateDir = path.join(base, "golem-settlement");
    const { client, jobs } = fakeClient();
    jobs.set("dup", settled("dup", "failed", "boom"));

    const r1 = new SettlementRelay({ client, stateDir, dropboxDir: P.incoming, resolveSink: () => undefined, backoffMs: 1 });
    await r1.recordDispatch("dup");
    await r1.stop();
    // First drain consumes the drop into one item.
    expect(drainIncoming(P).length).toBe(1);

    // A fresh relay instance over the SAME durable dirs: the tombstone means it
    // does not re-drop. Even if it did, the worklist dedups on the stable id.
    const r2 = new SettlementRelay({ client, stateDir, dropboxDir: P.incoming, resolveSink: () => undefined, backoffMs: 1 });
    await r2.start(); // startup reconcile sees the done tombstone → no-op
    await r2.stop();
    expect(readdirSync(P.incoming).filter((n) => n.endsWith(".json")).length).toBe(0);
    drainIncoming(P);
    expect(listItems(P).map((i) => i.id)).toEqual(["golem-settle-dup"]);
  });

  test("crash between atomic drop and tombstone: re-drop + drain still one item", async () => {
    const base = newDir();
    const P = worklistPaths(path.join(base, "worklist"));
    ensureDirs(P);
    const stateDir = path.join(base, "golem-settlement");
    const { client, jobs } = fakeClient();
    jobs.set("crashy", settled("crashy", "done", "recovered"));

    // First relay drops the envelope but we simulate a crash by draining nothing
    // and starting a second relay that finds an existing same-id drop.
    const r1 = new SettlementRelay({ client, stateDir, dropboxDir: P.incoming, resolveSink: () => undefined, backoffMs: 1 });
    await r1.recordDispatch("crashy");
    await r1.stop();
    // The drop exists AND a tombstone was written (normal path). Simulate the
    // crash window by removing the tombstone so the next run reprocesses.
    rmSync(path.join(stateDir, "done", "crashy.json"), { force: true });
    // Recreate the owned+pending marker as if the crash left them behind: easiest
    // is a fresh dispatch of the same id — recordDispatch re-owns and reconciles.
    const r2 = new SettlementRelay({ client, stateDir, dropboxDir: P.incoming, resolveSink: () => undefined, backoffMs: 1 });
    await r2.recordDispatch("crashy"); // sees existing drop → treats as accepted
    await r2.stop();
    // Still exactly one drop file (existing same-id drop was not overwritten).
    expect(readdirSync(P.incoming).filter((n) => n.endsWith(".json") && !n.includes(".tmp")).length).toBe(1);
    drainIncoming(P);
    expect(listItems(P).map((i) => i.id)).toEqual(["golem-settle-crashy"]);
  });

  test("absent/unwritable dropbox dir and no sink → relay retains pending", async () => {
    const base = newDir();
    const stateDir = path.join(base, "golem-settlement");
    const { client, jobs } = fakeClient();
    jobs.set("held", settled("held", "done", "waiting"));

    // (a) No dropbox configured at all.
    const r1 = new SettlementRelay({ client, stateDir, resolveSink: () => undefined, backoffMs: 1 });
    await r1.recordDispatch("held");
    await r1.stop();
    expect(existsSync(path.join(stateDir, "pending", "held.json"))).toBe(true);
    expect(existsSync(path.join(stateDir, "done", "held.json"))).toBe(false);

    // (b) Dropbox points at a non-existent dir → atomic write fails → retained.
    const r2 = new SettlementRelay({ client, stateDir, dropboxDir: path.join(base, "does-not-exist", "incoming"), resolveSink: () => undefined, backoffMs: 1 });
    await r2.flushPending();
    await r2.stop();
    expect(existsSync(path.join(stateDir, "pending", "held.json"))).toBe(true);
    expect(existsSync(path.join(stateDir, "done", "held.json"))).toBe(false);
  });

  test("an unrelated conflicting drop is never overwritten or accepted", async () => {
    const base = newDir();
    const P = worklistPaths(path.join(base, "worklist"));
    ensureDirs(P);
    const conflict = path.join(P.incoming, "golem-settle-conflict.json");
    const unrelated = { id: "some-other-item", summary: "do not clobber" };
    writeFileSync(conflict, JSON.stringify(unrelated), { mode: 0o600 });

    const { client, jobs } = fakeClient();
    jobs.set("conflict", settled("conflict", "done", "held safely"));
    const stateDir = path.join(base, "golem-settlement");
    const relay = new SettlementRelay({ client, stateDir, dropboxDir: P.incoming, resolveSink: () => undefined, backoffMs: 1 });
    await relay.recordDispatch("conflict");
    await relay.stop();

    expect(JSON.parse(readFileSync(conflict, "utf8"))).toEqual(unrelated);
    expect(existsSync(path.join(stateDir, "pending", "conflict.json"))).toBe(true);
    expect(existsSync(path.join(stateDir, "done", "conflict.json"))).toBe(false);
  });

  test("sink-available path still wins: no dropbox file is written", async () => {
    const base = newDir();
    const P = worklistPaths(path.join(base, "worklist"));
    ensureDirs(P);
    const seen = new Map<string, DurableEnqueueEnvelope>();
    const sink: DurableSink = {
      async enqueue(env: DurableEnqueueEnvelope): Promise<DurableAcceptance> {
        const id = env.id ?? `m${seen.size}`; seen.set(id, env); return { accepted: true, id };
      },
      async withdraw() { return true; },
    };
    const { client, jobs } = fakeClient();
    jobs.set("viasink", settled("viasink", "done", "fast path"));
    const relay = new SettlementRelay({ client, stateDir: path.join(base, "golem-settlement"), dropboxDir: P.incoming, resolveSink: () => sink, backoffMs: 1 });
    await relay.recordDispatch("viasink");
    await relay.stop();
    expect(seen.has("golem-settle-viasink")).toBe(true);
    // The fast path took it; nothing was written to the dropbox.
    expect(readdirSync(P.incoming).filter((n) => n.endsWith(".json")).length).toBe(0);
    expect(existsSync(path.join(base, "golem-settlement", "done", "viasink.json"))).toBe(true);
  });

  test("blocked job → dropbox → real drain → exactly one P0 question item; restart dedupes", async () => {
    const base = newDir();
    const P = worklistPaths(path.join(base, "worklist"));
    ensureDirs(P); // worklist owns creating its tree (incoming/ + items/)
    const { client, jobs } = fakeClient();
    const q = { id: "q777", prompt: "Deploy to prod now?", options: ["yes", "no"] };
    jobs.set("job-777", { id: "job-777", state: "blocked", harness: "pi", model: "op/m", question: q });
    const stateDir = path.join(base, "golem-settlement");
    // resolveSink undefined — the live loader-isolation symptom; blocked uses the drop-box.
    const relay = new SettlementRelay({ client, stateDir, dropboxDir: P.incoming, resolveSink: () => undefined, backoffMs: 1 });
    await relay.recordDispatch("job-777"); // blocked → durable drop
    await relay.stop();

    const drops = readdirSync(P.incoming).filter((n) => n.endsWith(".json"));
    expect(drops.length).toBe(1);

    // The REAL worklist drain promotes it to exactly one P0 question item.
    const created = drainIncoming(P);
    expect(created.length).toBe(1);
    const item = created[0];
    expect(item.id).toBe("golem-blocked-job-777-q777");
    expect(item.type).toBe("question");
    expect(item.priority).toBe(0);
    expect(item.source).toBe("golem");
    expect(item.body).toContain("job job-777 — BLOCKED");
    expect(item.body).toContain("Deploy to prod now?");
    expect(item.body).toContain("1. yes");
    expect(item.body).toContain("2. no");
    expect(listItems(P).map((i) => i.id)).toEqual(["golem-blocked-job-777-q777"]);

    // Restart: job STILL blocked → the live marker dedups; no second drop, and
    // the real store already owns the one item (drained above).
    const relay2 = new SettlementRelay({ client, stateDir, dropboxDir: P.incoming, resolveSink: () => undefined, backoffMs: 1 });
    await relay2.start();
    await relay2.stop();
    expect(readdirSync(P.incoming).filter((n) => n.endsWith(".json")).length).toBe(0);
    expect(listItems(P).map((i) => i.id)).toEqual(["golem-blocked-job-777-q777"]); // still exactly one
  });
});
