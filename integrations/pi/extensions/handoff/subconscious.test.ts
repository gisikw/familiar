import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyOps,
  curate,
  DEFAULT_TIMEOUT_MS,
  hazard,
  MAX_OPS,
  MAX_REMINDERS,
  MAX_TEXT_CHARS,
  parseCuration,
  renderCurationPrompt,
  renderDelivery,
  SubconsciousStore,
  subconsciousRoot,
  type CurationResponse,
  type LlmMessage,
  type Reminder,
} from "./subconscious.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

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

const origin = { sessionId: "sess-1234abcd", handoffArchive: "/h/2026.md" };
const reminder = (id: string, text: string, priority: Reminder["priority"] = "normal", turns = 0): Reminder =>
  ({ id, text, priority, turns, createdAt: 1_000_000, origin });
const reply = (text: string, stopReason = "stop"): CurationResponse =>
  ({ stopReason, content: [{ type: "text", text }] });
const context: LlmMessage[] = [
  { role: "user", content: [{ type: "text", text: "earlier conversation" }] },
  { role: "assistant", content: [{ type: "text", text: "earlier reply" }] },
  { role: "user", content: [{ type: "text", text: "HANDOFF PROMPT" }] },
];

describe("parseCuration: strict bounded JSON", () => {
  test("accepts only bare JSON objects with optional surrounding whitespace", () => {
    const ops = '{"ops":[{"op":"add","text":"a","priority":"high"},{"op":"set","id":"r-00000001","priority":"low"},{"op":"remove","id":"r-00000002"}]}';
    expect(parseCuration(ops)).toHaveLength(3);
    expect(parseCuration("  \n" + ops + "\n")).toHaveLength(3);
  });

  test("rejects fenced JSON, prose-wrapped JSON, and multiple objects", () => {
    const ops = '{"ops":[{"op":"add","text":"a","priority":"high"}]}';
    expect(parseCuration("```json\n" + ops + "\n```")).toBeNull();
    expect(parseCuration("Here is the JSON: " + ops)).toBeNull();
    expect(parseCuration(ops + " done")).toBeNull();
    expect(parseCuration(ops + ops)).toBeNull();
  });

  test("empty ops is a valid no-op", () => {
    expect(parseCuration('{"ops":[]}')).toEqual([]);
  });

  test("rejects malformed ops, unknown keys, bad ids, and oversize", () => {
    const bad = [
      "Sure! Here are my reminders.",
      'Here you go: {"ops":[]}',
      '{"ops":[]} trailing',
      "[]",
      "null",
      '{"reminders":[]}',
      '{"ops":[],"note":"x"}',
      '{"ops":{}}',
      '{"ops":[{"op":"replace","id":"r-00000001","text":"x"}]}',
      '{"ops":[{"op":"add","text":"x","priority":"urgent"}]}',
      '{"ops":[{"op":"add","text":"x"}]}',
      '{"ops":[{"op":"add","text":"","priority":"low"}]}',
      '{"ops":[{"op":"add","text":"   ","priority":"low"}]}',
      `{"ops":[{"op":"add","text":"${"x".repeat(MAX_TEXT_CHARS + 1)}","priority":"low"}]}`,
      '{"ops":[{"op":"add","text":"x","priority":"low","when":"tomorrow"}]}',
      '{"ops":[{"op":"set","id":"r-00000001"}]}',
      '{"ops":[{"op":"set","id":"nope","text":"x"}]}',
      '{"ops":[{"op":"set","id":"r-00000001","text":5}]}',
      '{"ops":[{"op":"remove","id":"../../etc/passwd"}]}',
      '{"ops":[{"op":"remove"}]}',
      `{"ops":[${Array(MAX_OPS + 1).fill('{"op":"remove","id":"r-00000001"}').join(",")}]}`,
      "x".repeat(20_000),
    ];
    for (const text of bad) expect(parseCuration(text)).toBeNull();
    expect(parseCuration(`{"ops":[${Array(MAX_OPS).fill('{"op":"remove","id":"r-00000001"}').join(",")}]}`)).toHaveLength(MAX_OPS);
  });
});

describe("applyOps: add, amend, reprioritize, remove, replace", () => {
  const mint = { now: () => 5, id: () => "r-0000ffff", origin };

  test("applies in order and leaves the input untouched", () => {
    const existing = [reminder("r-00000001", "one", "low", 7), reminder("r-00000002", "two")];
    const snapshot = JSON.stringify(existing);
    const next = applyOps(existing, [
      { op: "set", id: "r-00000001", text: "  one, amended  ", priority: "high" },
      { op: "remove", id: "r-00000002" },
      { op: "add", text: " three ", priority: "normal" },
    ], mint);
    expect(JSON.stringify(existing)).toBe(snapshot);
    expect(next).toEqual([
      { ...existing[0], text: "one, amended", priority: "high" },
      { id: "r-0000ffff", text: "three", priority: "normal", turns: 0, createdAt: 5, origin },
    ]);
    expect(next[0].turns).toBe(7); // amending keeps the wait
  });

  test("unknown ids and overflow reject the whole batch", () => {
    expect(() => applyOps([], [{ op: "remove", id: "r-00000009" }], mint)).toThrow(/unknown/);
    expect(() => applyOps([], [{ op: "set", id: "r-00000009", text: "x" }], mint)).toThrow(/unknown/);
    const full = Array.from({ length: MAX_REMINDERS }, (_, i) => reminder(`r-0000000${i + 1}`, `n${i}`));
    expect(() => applyOps(full, [{ op: "add", text: "one too many", priority: "low" }], mint)).toThrow(/more than/);
    // Replacing within the cap is fine.
    expect(applyOps(full, [{ op: "remove", id: "r-00000001" }, { op: "add", text: "swap", priority: "low" }], mint)).toHaveLength(MAX_REMINDERS);
  });
});

describe("curate: one ephemeral dispatch, outgoing context, graceful failure", () => {
  test("dispatches exactly once with the outgoing context, the handoff, then the curation prompt", async () => {
    const { store } = fixture();
    store.save([reminder("r-00000001", "carry me")]);
    const calls: LlmMessage[][] = [];
    const outcome = await curate({
      messages: context, handoff: "THE HANDOFF", store, origin,
      complete: async (messages) => { calls.push(messages); return reply('{"ops":[{"op":"add","text":"new","priority":"high"}]}'); },
    });
    expect(outcome).toEqual({ outcome: "applied", ops: 1, reminders: 2 });
    expect(calls).toHaveLength(1);
    const sent = calls[0];
    expect(sent.slice(0, 3)).toEqual(context);
    expect(sent[3].role).toBe("assistant");
    expect((sent[3].content as any)[0].text).toBe("THE HANDOFF");
    expect(sent[4].role).toBe("user");
    const prompt = (sent[4].content as any)[0].text as string;
    expect(prompt).toContain("r-00000001");
    expect(prompt).toContain("carry me");
    expect(prompt).toContain('{"ops":[]}');
    expect(store.list().map((r) => r.text)).toEqual(["carry me", "new"]);
    expect(store.list()[1].origin).toEqual(origin);
  });

  test("empty ops is a no-op that touches nothing", async () => {
    const { store } = fixture();
    store.save([reminder("r-00000001", "keep")]);
    const before = fs.statSync(store.file).mtimeMs;
    const outcome = await curate({ messages: context, handoff: "h", store, origin, complete: async () => reply('{"ops":[]}') });
    expect(outcome).toEqual({ outcome: "noop" });
    expect(store.list()).toEqual([reminder("r-00000001", "keep")]);
    expect(fs.statSync(store.file).mtimeMs).toBe(before);
  });

  test("every failure skips without mutation and without throwing", async () => {
    const { store } = fixture();
    const initial = [reminder("r-00000001", "keep")];
    store.save(initial);
    const cases: Array<[string, () => Promise<CurationResponse>]> = [
      ["invalid-json", async () => reply("I'd add a reminder about the Johnson call.")],
      ["invalid-json", async () => reply("")],
      ["invalid-json", async () => reply('{"ops":[{"op":"add","text":"x","priority":"soon"}]}')],
      ["stopReason:error", async () => reply("", "error")],
      ["stopReason:length", async () => reply('{"ops":[{"op":"add","text":"tru', "length")],
      ["stopReason:aborted", async () => reply("", "aborted")],
      ["Error", async () => { throw new Error("provider down"); }],
      ["Error", async () => reply('{"ops":[{"op":"remove","id":"r-00000099"}]}')],
    ];
    for (const [reason, complete] of cases) {
      const outcome = await curate({ messages: context, handoff: "h", store, origin, complete });
      expect(outcome).toEqual({ outcome: "skipped", reason });
      expect(store.list()).toEqual(initial);
    }
  });

  test("a hung model times out, aborts the request, and skips", async () => {
    // The default bound is interactive latency on /clear: aborting instead
    // would cancel the compaction Pi is holding open, handoff and all.
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    const { store } = fixture();
    let seen: AbortSignal | undefined;
    const outcome = await curate({
      messages: context, handoff: "h", store, origin, timeoutMs: 20,
      complete: (_m, signal) => { seen = signal; return new Promise(() => {}); },
    });
    expect(outcome).toEqual({ outcome: "skipped", reason: "timeout" });
    expect(seen?.aborted).toBe(true);
    expect(store.list()).toEqual([]);
  });

  test("an already-cancelled compaction never dispatches", async () => {
    const { store } = fixture();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const outcome = await curate({
      messages: context, handoff: "h", store, origin, signal: controller.signal,
      complete: async () => { calls++; return reply('{"ops":[]}'); },
    });
    expect(outcome).toEqual({ outcome: "skipped", reason: "aborted" });
    expect(calls).toBe(0);
  });

  test("a store that moved underneath the request is not guessed at", async () => {
    const { store } = fixture();
    const outcome = await curate({
      messages: context, handoff: "h", store, origin,
      complete: async () => {
        store.save([reminder("r-00000001", "someone else")]);
        return reply('{"ops":[{"op":"add","text":"x","priority":"low"}]}');
      },
    });
    expect(outcome).toEqual({ outcome: "skipped", reason: "store-changed" });
    expect(store.list().map((r) => r.text)).toEqual(["someone else"]);
  });
});

describe("store and delivery", () => {
  test("writes one 0600 file under a 0700 root and reads it back", () => {
    const { root, store } = fixture();
    store.save([reminder("r-00000001", "a")]);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root)).toEqual(["reminders.json"]);
    expect(store.list()).toEqual([reminder("r-00000001", "a")]);
  });

  test("corrupt or oversize content reads as empty and is set aside", () => {
    const { root, store } = fixture();
    fs.writeFileSync(store.file, "{not json");
    expect(store.list()).toEqual([]);
    expect(fs.readdirSync(root).some((f) => f.endsWith(".corrupt"))).toBe(true);
    fs.writeFileSync(store.file, JSON.stringify({ version: 1, reminders: [{ id: "r-00000001", text: "x".repeat(401), priority: "low", turns: 0, createdAt: 0, origin }] }));
    expect(store.list()).toEqual([]);
    expect(() => store.save(Array.from({ length: MAX_REMINDERS + 1 }, (_, i) => reminder(`r-0000000${i}`, "x")))).toThrow();
  });

  test("hazard: quiet in grace, ramps, certain at the ceiling", () => {
    expect(hazard("high", 1)).toBe(0);
    expect(hazard("high", 2)).toBeCloseTo(0.15 + (0.35 / 15), 6);
    expect(hazard("high", 40)).toBe(1);
    expect(hazard("normal", 5)).toBe(0);
    expect(hazard("normal", 65)).toBeCloseTo(0.25, 6);
    expect(hazard("normal", 200)).toBe(1);
    expect(hazard("low", 20)).toBe(0);
    expect(hazard("low", 600)).toBe(1);
  });

  test("draw ages everything, removes at most one, and drains at the ceiling", () => {
    const { store } = fixture(() => 0.999);
    store.save([reminder("r-00000001", "h", "high"), reminder("r-00000002", "l", "low")]);
    for (let turn = 1; turn < 40; turn++) expect(store.draw()).toBeNull();
    expect(store.list().map((r) => r.turns)).toEqual([39, 39]);
    const drawn = store.draw();
    expect(drawn?.id).toBe("r-00000001");
    expect(store.list().map((r) => r.id)).toEqual(["r-00000002"]);
    expect(store.draw()).toBeNull(); // already gone: at most once
  });

  test("draw selects by chance and only one per turn", () => {
    const { store } = fixture(() => 0);
    store.save([reminder("r-00000001", "a", "high", 5), reminder("r-00000002", "b", "high", 5)]);
    expect(store.draw()?.id).toBe("r-00000001");
    expect(store.list().map((r) => [r.id, r.turns])).toEqual([["r-00000002", 6]]);
  });

  test("delivery is a system reminder with origin, never the user's voice", () => {
    const text = renderDelivery(reminder("r-00000001", "remember the Johnson call"), 1_000_000 + 3 * 3_600_000);
    expect(text.startsWith("<system-reminder>")).toBe(true);
    expect(text).toContain("remember the Johnson call");
    expect(text).toContain("about 3 hours ago");
    expect(text).toContain("session sess-123");
    expect(text).toContain("handoff /h/2026.md");
    expect(text).toContain("The user did not send it");
  });

  test("curation prompt lists ids and bounds", () => {
    const text = renderCurationPrompt([reminder("r-00000001", "x", "low", 3)], 1_000_000);
    expect(text).toContain("id r-00000001 · low");
    expect(text).toContain(`${MAX_TEXT_CHARS} characters`);
    expect(text).toContain(`1/${MAX_REMINDERS}`);
    expect(renderCurationPrompt([], 0)).toContain("(none)");
  });

  test("root resolves to the sibling of the pi dir, never inside it", () => {
    expect(subconsciousRoot({ FAMILIAR_SUBCONSCIOUS_DIR: "/s/x" })).toBe("/s/x");
    expect(subconsciousRoot({ PI_CODING_AGENT_DIR: "/state/pi" })).toBe("/state/subconscious");
  });
});
