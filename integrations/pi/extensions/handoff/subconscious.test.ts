import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyOps,
  curate,
  DEFAULT_TIMEOUT_MS,
  deliveryProbability,
  MAX_CURVE_HOURS,
  MAX_CURVE_TURNS,
  MAX_OPS,
  MAX_REMINDERS,
  MAX_TEXT_CHARS,
  parseCuration,
  renderCurationPrompt,
  renderDelivery,
  SubconsciousStore,
  subconsciousRoot,
  validCurve,
  type CurationResponse,
  type DeliveryCurve,
  type LlmMessage,
  type Reminder,
} from "./subconscious.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const curve = (chance: [number, number] = [0, 1]): DeliveryCurve =>
  ({ turns: [2, 10], hours: [1, 5], chance });
const origin = { sessionId: "fixture-session", handoffArchive: "/fixture/handoff.md" };
const reminder = (id: string, text = "fixture note", c = curve(), turns = 0, createdAt = 1_000_000): Reminder =>
  ({ id, text, curve: c, turns, createdAt, origin });
const addJson = (text = "new fixture", c = curve()) => JSON.stringify({ ops: [{ op: "add", text, curve: c }] });
const reply = (text: string, stopReason = "stop"): CurationResponse =>
  ({ stopReason, content: [{ type: "text", text }] });
const context: LlmMessage[] = [{ role: "user", content: [{ type: "text", text: "fixture context" }] }];

function fixture(random: () => number = () => 0.99) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-subconscious-"));
  roots.push(root);
  let clock = 1_000_000;
  let serial = 0;
  const store = new SubconsciousStore(root, {
    now: () => clock,
    random,
    id: () => `r-${(++serial).toString(16).padStart(8, "0")}`,
  });
  return { root, store, tick: (ms: number) => { clock += ms; } };
}

describe("curation schema and cardinality", () => {
  test("accepts no-op or exactly one mutation", () => {
    expect(MAX_OPS).toBe(1);
    expect(parseCuration('{"ops":[]}')).toEqual([]);
    expect(parseCuration(addJson())).toHaveLength(1);
    expect(parseCuration(JSON.stringify({ ops: [{ op: "set", id: "r-00000001", curve: curve() }] }))).toHaveLength(1);
    expect(parseCuration('{"ops":[{"op":"remove","id":"r-00000001"}]}')).toHaveLength(1);
  });

  test("strictly rejects multi-operation replies rather than truncating", () => {
    const two = JSON.stringify({ ops: [
      { op: "remove", id: "r-00000001" },
      { op: "add", text: "replacement", curve: curve() },
    ] });
    expect(parseCuration(two)).toBeNull();
    expect(() => applyOps([reminder("r-00000001")], [
      { op: "remove", id: "r-00000001" },
      { op: "add", text: "replacement", curve: curve() },
    ], { now: () => 2, id: () => "r-00000002", origin })).toThrow(/more than 1 operation/);
  });

  test("rejects wrappers, unknown fields, and malformed curve values", () => {
    const malformed: unknown[] = [
      null, [], { turns: [0, 2], hours: [0, 2] },
      { turns: [0, 2], hours: [0, 2], chance: [0, 1], extra: 1 },
      { turns: [0, 2.5], hours: [0, 2], chance: [0, 1] },
      { turns: [-1, 2], hours: [0, 2], chance: [0, 1] },
      { turns: [2, 2], hours: [0, 2], chance: [0, 1] },
      { turns: [0, MAX_CURVE_TURNS + 1], hours: [0, 2], chance: [0, 1] },
      { turns: [0, 2], hours: [0, MAX_CURVE_HOURS + 1], chance: [0, 1] },
      { turns: [0, 2], hours: [0, 2], chance: [-0.1, 1] },
      { turns: [0, 2], hours: [0, 2], chance: [0.8, 0.2] },
      { turns: [0, 2], hours: [0, 2], chance: [0, 1.1] },
      { turns: [0, 2], hours: [0, 2], chance: [Number.NaN, 1] },
      { turns: [0, 2], hours: [0, Number.POSITIVE_INFINITY], chance: [0, 1] },
    ];
    for (const c of malformed) {
      expect(validCurve(c)).toBe(false);
      expect(parseCuration(JSON.stringify({ ops: [{ op: "add", text: "x", curve: c }] }))).toBeNull();
    }
    expect(parseCuration("```json\n" + addJson() + "\n```")).toBeNull();
    expect(parseCuration(addJson() + " trailing")).toBeNull();
    expect(parseCuration(JSON.stringify({ ops: [{ op: "add", text: "x", curve: curve(), priority: "high" }] }))).toBeNull();
    expect(parseCuration(JSON.stringify({ ops: [{ op: "add", text: "x".repeat(MAX_TEXT_CHARS + 1), curve: curve() }] }))).toBeNull();
  });

  test("one accepted mutation changes exactly one record and preserves capacity", () => {
    const existing = [reminder("r-00000001", "first"), reminder("r-00000002", "second")];
    const next = applyOps(existing, [{ op: "set", id: "r-00000001", text: "changed", curve: curve([0.1, 0.4]) }], {
      now: () => 5, id: () => "r-00000003", origin,
    });
    expect(next[0].text).toBe("changed");
    expect(next[1]).toEqual(existing[1]);
    expect(existing[0].text).toBe("first");
    const full = Array.from({ length: MAX_REMINDERS }, (_, i) => reminder(`r-${(i + 1).toString(16).padStart(8, "0")}`));
    expect(() => applyOps(full, [{ op: "add", text: "overflow", curve: curve() }], { now: () => 5, id: () => "r-ffffffff", origin })).toThrow(/more than/);
  });
});

describe("authored delivery probability", () => {
  test("turn and wall-clock age each affect probability monotonically", () => {
    const c = curve([0, 0.8]);
    const zero = deliveryProbability(c, 0, 0);
    const byTurns = deliveryProbability(c, 6, 0);
    const byTime = deliveryProbability(c, 0, 3 * 3_600_000);
    const both = deliveryProbability(c, 6, 3 * 3_600_000);
    expect(zero).toBe(0);
    expect(byTurns).toBeCloseTo(0.2);
    expect(byTime).toBeCloseTo(0.2);
    expect(both).toBeCloseTo(0.4);
    expect(both).toBeGreaterThanOrEqual(byTurns);
    expect(deliveryProbability(c, 10, 5 * 3_600_000)).toBeCloseTo(0.8);
  });

  test("zero, near, and fully mature chance follow the authored bounds", () => {
    const c = curve([0.02, 0.42]);
    expect(deliveryProbability(c, 0, 0)).toBe(0.02);
    expect(deliveryProbability(c, 3, 0)).toBeGreaterThan(0.02);
    expect(deliveryProbability(c, 10_000, 365 * 24 * 3_600_000)).toBe(0.42);
  });
});

describe("store, migration, and deterministic delivery", () => {
  test("writes strict v2 atomically with safe permissions", () => {
    const { root, store } = fixture();
    store.save([reminder("r-00000001")]);
    const doc = JSON.parse(fs.readFileSync(store.file, "utf8"));
    expect(doc.version).toBe(2);
    expect(doc.reminders[0].curve).toEqual(curve());
    expect(doc.reminders[0].priority).toBeUndefined();
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  });

  test("hydrates deployed v1 records without inspecting or eagerly rewriting bodies", () => {
    const { store } = fixture();
    const legacy = { version: 1, reminders: [
      { id: "r-00000001", text: "legacy fixture", priority: "normal", turns: 7, createdAt: 10, origin },
    ] };
    const bytes = JSON.stringify(legacy);
    fs.writeFileSync(store.file, bytes);
    const hydrated = store.list();
    expect(hydrated[0].text).toBe("legacy fixture");
    expect(hydrated[0].curve).toEqual({ turns: [5, 200], hours: [24, 720], chance: [0.03, 0.25] });
    expect(fs.readFileSync(store.file, "utf8")).toBe(bytes);
  });

  test("rejects malformed v2 records and save failures leave the previous file intact", () => {
    const { store } = fixture();
    const initial = [reminder("r-00000001", "stable fixture")];
    store.save(initial);
    const before = fs.readFileSync(store.file, "utf8");
    expect(() => store.save([{ ...initial[0], curve: { ...curve(), chance: [0.9, 0.1] } } as Reminder])).toThrow();
    expect(fs.readFileSync(store.file, "utf8")).toBe(before);
  });

  test("injected RNG is deterministic and scan stops at first success", () => {
    const values = [0.9, 0.1, 0.0];
    let calls = 0;
    const { store } = fixture(() => values[calls++]);
    const c = curve([0.5, 0.5]);
    store.save([reminder("r-00000001", "miss", c), reminder("r-00000002", "hit", c), reminder("r-00000003", "not scanned", c)]);
    expect(store.draw()?.id).toBe("r-00000002");
    expect(calls).toBe(2);
    expect(store.list().map((r) => r.id)).toEqual(["r-00000001", "r-00000003"]);
  });

  test("one turn can never deliver two, while adjacent-turn clustering remains possible", () => {
    const { store } = fixture(() => 0);
    const certain = curve([1, 1]);
    store.save([reminder("r-00000001", "first", certain), reminder("r-00000002", "second", certain)]);
    expect(store.draw()?.id).toBe("r-00000001");
    expect(store.list()).toHaveLength(1);
    expect(store.draw()?.id).toBe("r-00000002");
    expect(store.list()).toHaveLength(0);
  });

  test("wall time changes a draw outcome with fixed RNG", () => {
    const f = fixture(() => 0.3);
    f.store.save([reminder("r-00000001", "time fixture", curve([0, 0.8]))]);
    expect(f.store.draw()).toBeNull();
    f.tick(5 * 3_600_000);
    expect(f.store.draw()?.id).toBe("r-00000001");
  });
});

describe("curate atomicity and presentation", () => {
  test("multi-op response leaves the store byte-for-byte untouched", async () => {
    const { store } = fixture();
    store.save([reminder("r-00000001", "stable fixture")]);
    const before = fs.readFileSync(store.file, "utf8");
    const result = await curate({
      messages: context, handoff: "fixture handoff", store, origin,
      complete: async () => reply(JSON.stringify({ ops: [
        { op: "remove", id: "r-00000001" },
        { op: "add", text: "replacement", curve: curve() },
      ] })),
    });
    expect(result).toEqual({ outcome: "skipped", reason: "invalid-json" });
    expect(fs.readFileSync(store.file, "utf8")).toBe(before);
  });

  test("exactly one valid mutation is applied after one dispatch", async () => {
    const { store } = fixture();
    let calls = 0;
    const result = await curate({ messages: context, handoff: "fixture handoff", store, origin, complete: async () => {
      calls++;
      return reply(addJson());
    } });
    expect(result).toEqual({ outcome: "applied", ops: 1, reminders: 1 });
    expect(calls).toBe(1);
    expect(store.list()[0].curve).toEqual(curve());
  });

  test("provider failure, timeout, and unknown id do not mutate", async () => {
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    const { store } = fixture();
    const cases = [
      async () => reply('{"ops":[{"op":"remove","id":"r-ffffffff"}]}'),
      async () => { throw new Error("fixture failure"); },
    ];
    for (const complete of cases) {
      expect((await curate({ messages: context, handoff: "h", store, origin, complete })).outcome).toBe("skipped");
      expect(store.list()).toEqual([]);
    }
    const timeout = await curate({ messages: context, handoff: "h", store, origin, timeoutMs: 5, complete: async () => new Promise(() => {}) });
    expect(timeout).toEqual({ outcome: "skipped", reason: "timeout" });
  });

  test("prompt authors private attention rather than a task-list reminder", () => {
    const prompt = renderCurationPrompt([reminder("r-00000001")], 1_000_000, {});
    expect(prompt).toContain("one last private opportunity");
    expect(prompt).toContain("one deliberate seed");
    expect(prompt).toContain("a joke whose setup needs to be forgotten");
    expect(prompt).toContain("a provocation");
    expect(prompt).toContain("not a second handoff, a task list");
    expect(prompt).toContain("attentional nudge, not a command or a prewritten response");
    expect(prompt).toContain("future self retains judgment");
    expect(prompt).toContain("Plant at most one seed");
    expect(prompt).toContain("planting none is valid");
    expect(prompt).toContain("authored stochastic delivery curve");
    expect(prompt).toContain("cannot select or guarantee the moment");
    expect(prompt).toContain("without the user first leading the next Familiar there");
    expect(prompt).not.toContain("one last private task");
    expect(prompt).not.toContain("subconscious reminders");
    expect(prompt).not.toContain("thread to revisit");
    expect(prompt).toContain("no more than ONE operation");
    expect(prompt).toContain('"turns":[quiet,mature]');
    expect(prompt).toContain("probability, not a delivery promise");
    expect(prompt).toContain(`1/${MAX_REMINDERS}`);
    const delivered = renderDelivery(reminder("r-00000001", "fixture delivery"), 2_000_000);
    expect(delivered).toContain("<system-reminder>");
    expect(delivered).toContain("fixture delivery");
    expect(delivered).toContain("The user did not send it");
    expect(delivered).toContain("handoff /fixture/handoff.md");
    expect(renderDelivery({ ...reminder("r-00000002"), origin: { sessionId: "fixture-session", compactionEntryId: "deadbeef" } }, 2_000_000))
      .toContain("handoff compaction deadbeef");
    expect(subconsciousRoot({ PI_CODING_AGENT_DIR: "/state/pi" })).toBe("/state/subconscious");
  });

  test("prompt interpolates each party independently and uses neutral per-field fallbacks", () => {
    const identified = renderCurationPrompt([], 1_000_000, {
      FAMILIAR_USER_NAME: "User Fixture",
      FAMILIAR_USER_PRONOUN_SUBJECT: "xe",
      FAMILIAR_IDENTITY_NAME: "Familiar Fixture",
      FAMILIAR_IDENTITY_PRONOUN_SUBJECT: "they",
      FAMILIAR_IDENTITY_PRONOUN_OBJECT: "them",
      FAMILIAR_IDENTITY_PRONOUN_POSSESSIVE_ADJECTIVE: "their",
      FAMILIAR_IDENTITY_PRONOUN_POSSESSIVE_PRONOUN: "theirs",
      FAMILIAR_IDENTITY_PRONOUN_REFLEXIVE: "themself",
    });
    expect(identified).toContain("your next self, Familiar Fixture,");
    expect(identified).toContain("direct their attention");
    expect(identified).toContain("they can only respond to what reaches them");
    expect(identified).toContain("without User Fixture first leading them there");
    expect(identified).toContain("a chance for them to surprise themself");
    expect(identified).toContain("the choice remains theirs");
    expect(identified).toContain("They will meet the seed");
    expect(identified).not.toContain("they sees");
    expect(identified).not.toContain("they retains");

    const userSubjectOnly = renderCurationPrompt([], 1_000_000, { FAMILIAR_USER_PRONOUN_SUBJECT: "they" });
    expect(userSubjectOnly).toContain("before they can lead the next Familiar there");
    expect(userSubjectOnly).not.toContain("without they first leading");
    const userObjectOnly = renderCurationPrompt([], 1_000_000, { FAMILIAR_USER_PRONOUN_OBJECT: "them" });
    expect(userObjectOnly).toContain("without them first leading the next Familiar there");
    const invalidPrivateValue = "PRIVATE_FIXTURE_" + "x".repeat(129);
    const fallback = renderCurationPrompt([], 1_000_000, { FAMILIAR_USER_NAME: invalidPrivateValue });
    expect(fallback).toContain("without the user first leading the next Familiar there");
    expect(fallback).not.toContain(invalidPrivateValue);
    expect(fallback).not.toMatch(/\b(she|her|hers|herself)\b/i);
  });
});
