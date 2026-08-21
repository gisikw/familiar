/* ============================================================================
 * capabilities + worklist⇄subagent seam — headless contract tests.
 * Run with:  nix develop .#stt -c bun test extensions/lib/capabilities.test.ts
 * ============================================================================
 *
 * These tests exercise the neutral registry and a FAITHFUL model of the seam
 * both extensions implement: worklist registers an async durable sink with
 * dedup + withdraw + tombstone; subagent resolves it at delivery time and
 * falls back to a direct relay when absent/rejected/errored. The
 * exactly-once/dedup invariant (an await claiming a settlement already queued
 * in the worklist) is modelled directly against a real on-disk store so a
 * regression in the store surfaces here too.
 */
import { expect, test, describe, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createCapabilityRegistry,
  registry as globalRegistry,
  WORKLIST_SINK,
  WORKLIST_SINK_VERSION,
  type DurableSink,
  type DurableAcceptance,
  type DurableEnqueueEnvelope,
} from "./capabilities.ts";
import {
  worklistPaths,
  ensureDirs,
  getItem,
  putItem,
  envelopeToItem,
  listItems,
} from "../worklist/store.ts";
import { isPending } from "../worklist/policy.ts";

describe("capability registry: register/resolve/unregister/dispose", () => {
  test("resolve returns undefined when nothing registered", () => {
    const r = createCapabilityRegistry();
    expect(r.resolve("x", 1)).toBeUndefined();
    expect(r.has("x", 1)).toBe(false);
  });

  test("register then resolve round-trips; disposer removes it", () => {
    const r = createCapabilityRegistry();
    const dispose = r.register("cap", 1, { hi: () => 42 });
    expect(r.has("cap", 1)).toBe(true);
    expect((r.resolve<{ hi: () => number }>("cap", 1))!.hi()).toBe(42);
    dispose();
    expect(r.resolve("cap", 1)).toBeUndefined();
  });

  test("version isolation: v1 and v2 do not collide", () => {
    const r = createCapabilityRegistry();
    r.register("cap", 1, "one");
    r.register("cap", 2, "two");
    expect(r.resolve("cap", 1)).toBe("one");
    expect(r.resolve("cap", 2)).toBe("two");
    // a consumer asking for a version nobody offers sees nothing
    expect(r.resolve("cap", 3)).toBeUndefined();
  });

  test("re-registration replaces; stale disposer is a no-op (token guard)", () => {
    const r = createCapabilityRegistry();
    const disposeA = r.register("cap", 1, "A");
    const disposeB = r.register("cap", 1, "B");
    expect(r.resolve("cap", 1)).toBe("B");
    disposeA(); // stale: must NOT evict B
    expect(r.resolve("cap", 1)).toBe("B");
    disposeB();
    expect(r.resolve("cap", 1)).toBeUndefined();
  });

  test("unregister and dispose clear entries", () => {
    const r = createCapabilityRegistry();
    r.register("a", 1, 1);
    r.register("b", 1, 2);
    r.unregister("a", 1);
    expect(r.has("a", 1)).toBe(false);
    expect(r.has("b", 1)).toBe(true);
    r.dispose();
    expect(r.has("b", 1)).toBe(false);
  });
});

/* --- a faithful worklist sink over a real store --------------------------- */
// Mirrors extensions/worklist/index.ts sink semantics so the seam invariants
// are tested without a running pi.
function makeSink(root: string): DurableSink & { _tombstones: Set<string> } {
  const P = worklistPaths(root);
  ensureDirs(P);
  const tombstones = new Set<string>();
  return {
    _tombstones: tombstones,
    async enqueue(env: DurableEnqueueEnvelope): Promise<DurableAcceptance> {
      const id = env.id;
      if (id && tombstones.has(id)) return { accepted: false, superseded: true, id };
      if (id) {
        const existing = getItem(P, id);
        if (existing) return { accepted: true, id };
      }
      const item = envelopeToItem({
        id,
        priority: env.priority,
        summary: env.summary,
        body: env.body,
        source: env.source ?? "subagent",
      });
      putItem(P, item);
      return { accepted: true, id: item.id };
    },
    async withdraw(id: string): Promise<boolean> {
      tombstones.add(id);
      const item = getItem(P, id);
      if (!item) return true;
      if (item.delivered || item.acked) return false;
      item.withdrawn = true;
      putItem(P, item);
      return true;
    },
  };
}

/* --- a faithful subagent relay against the resolved sink ------------------ */
// Returns "worklist" if the sink accepted, "direct" if it fell back, "owned"
// if superseded (no surface fired). Mirrors relay() in subagent/index.ts.
async function relay(
  reg: ReturnType<typeof createCapabilityRegistry>,
  id: string,
  onDirect: () => void,
): Promise<"worklist" | "direct" | "owned"> {
  const sink = reg.resolve<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION);
  if (sink) {
    try {
      const acc = await sink.enqueue({ id, summary: `settle ${id}`, body: "verdict", priority: 1 });
      if (acc.accepted) return "worklist";
      if (acc.superseded) return "owned";
    } catch {
      /* fall through to direct */
    }
  }
  onDirect();
  return "direct";
}

describe("seam: absence → direct-relay fallback", () => {
  test("no sink registered → subagent relays directly", async () => {
    const reg = createCapabilityRegistry();
    let direct = 0;
    const r = await relay(reg, "sub-1-1", () => direct++);
    expect(r).toBe("direct");
    expect(direct).toBe(1);
  });

  test("sink that throws → falls back to direct relay", async () => {
    const reg = createCapabilityRegistry();
    reg.register<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION, {
      async enqueue() { throw new Error("boom"); },
      async withdraw() { return true; },
    });
    let direct = 0;
    const r = await relay(reg, "sub-2-1", () => direct++);
    expect(r).toBe("direct");
    expect(direct).toBe(1);
  });

  test("sink that rejects (accepted:false, not superseded) → direct relay", async () => {
    const reg = createCapabilityRegistry();
    reg.register<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION, {
      async enqueue() { return { accepted: false }; },
      async withdraw() { return true; },
    });
    let direct = 0;
    const r = await relay(reg, "sub-3-1", () => direct++);
    expect(r).toBe("direct");
    expect(direct).toBe(1);
  });
});

describe("seam: durable acceptance", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-")); });

  test("present sink → settlement durably enqueued, no direct relay", async () => {
    const reg = createCapabilityRegistry();
    const sink = makeSink(root);
    reg.register<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION, sink);
    let direct = 0;
    const r = await relay(reg, "sub-10-1", () => direct++);
    expect(r).toBe("worklist");
    expect(direct).toBe(0);
    const P = worklistPaths(root);
    expect(getItem(P, "sub-10-1")?.summary).toContain("sub-10-1");
    expect(listItems(P).filter(isPending).length).toBe(1);
  });

  test("re-relay of the same settlement id does not duplicate", async () => {
    const reg = createCapabilityRegistry();
    reg.register<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION, makeSink(root));
    await relay(reg, "sub-11-1", () => {});
    await relay(reg, "sub-11-1", () => {}); // idempotent
    const P = worklistPaths(root);
    expect(listItems(P).filter((i) => i.id === "sub-11-1").length).toBe(1);
  });
});

describe("seam: duplicate prevention (await vs queued settlement)", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-dup-")); });

  test("await withdraws an already-queued settlement so it never surfaces twice", async () => {
    const reg = createCapabilityRegistry();
    const sink = makeSink(root);
    reg.register<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION, sink);
    const id = "sub-20-1";
    // 1. relay queues the settlement into the worklist
    expect(await relay(reg, id, () => {})).toBe("worklist");
    const P = worklistPaths(root);
    expect(listItems(P).filter(isPending).length).toBe(1);
    // 2. subagent_await claims it: must withdraw so the queued item is dead
    const removed = await sink.withdraw(id);
    expect(removed).toBe(true); // undelivered → we own the single surface now
    const item = getItem(P, id);
    expect(item?.withdrawn).toBe(true);
    expect(listItems(P).filter(isPending).length).toBe(0); // never surfaces
  });

  test("await after worklist already delivered → withdraw returns false (do not repeat)", async () => {
    const reg = createCapabilityRegistry();
    const sink = makeSink(root);
    reg.register<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION, sink);
    const id = "sub-21-1";
    await relay(reg, id, () => {});
    const P = worklistPaths(root);
    // simulate worklist having already surfaced it
    const item = getItem(P, id)!;
    item.delivered = true;
    item.acked = true;
    putItem(P, item);
    const removed = await sink.withdraw(id);
    expect(removed).toBe(false); // too late; await must NOT repeat the body
  });

  test("in-flight race: withdraw BEFORE enqueue resolves → enqueue is superseded", async () => {
    const reg = createCapabilityRegistry();
    const sink = makeSink(root);
    reg.register<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION, sink);
    const id = "sub-22-1";
    // await claims first (tombstone set), THEN a late relay tries to enqueue
    const removed = await sink.withdraw(id); // nothing queued yet
    expect(removed).toBe(true);
    const acc = await sink.enqueue({ id, summary: "late", body: "v", priority: 1 });
    expect(acc.accepted).toBe(false);
    expect(acc.superseded).toBe(true); // relay must NOT direct-relay either
    const P = worklistPaths(root);
    expect(listItems(P).filter(isPending).length).toBe(0);
  });
});

describe("seam: restart/test safety of registration", () => {
  test("global registry: re-register across a simulated reload disposes cleanly", () => {
    const first = globalRegistry.register<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION, {
      async enqueue() { return { accepted: true }; },
      async withdraw() { return true; },
    });
    expect(globalRegistry.has(WORKLIST_SINK, WORKLIST_SINK_VERSION)).toBe(true);
    // reload: dispose then re-register
    first();
    const second = globalRegistry.register<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION, {
      async enqueue() { return { accepted: true, id: "x" }; },
      async withdraw() { return true; },
    });
    expect(globalRegistry.has(WORKLIST_SINK, WORKLIST_SINK_VERSION)).toBe(true);
    second();
    expect(globalRegistry.has(WORKLIST_SINK, WORKLIST_SINK_VERSION)).toBe(false);
  });
});
