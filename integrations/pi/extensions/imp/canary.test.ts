import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCanary, recordCanary } from "./canary.ts";

const asst = (usage: Record<string, number>, model = "opus") => ({ type: "message", message: { role: "assistant", model, usage } });
const user = { type: "message", message: { role: "user", content: "x" } };
const marker = { type: "custom", customType: "familiar.fork.v1", data: {} };
const parent = asst({ input: 4, cacheRead: 180_000, cacheWrite: 1_000 });

test("a fork that reads the parent prefix is a hit", () => {
  const r = readCanary([user, parent, marker, user, asst({ input: 4, cacheRead: 179_500, cacheWrite: 2_000 })])!;
  expect(r.miss).toBe(false);
  expect(r.ratio).toBeGreaterThan(0.99);
});

test("the Oct 4-18 shape (7,243 read, everything rewritten) is flagged", () => {
  const r = readCanary([user, parent, marker, user, asst({ input: 4, cacheRead: 7_243, cacheWrite: 175_000 })])!;
  expect(r.miss).toBe(true);
  expect(r.parentPrefix).toBe(181_004);
});

test("no reading for the parent, fresh forks, or later calls", () => {
  expect(readCanary([user, parent, user, asst({ cacheRead: 1 })])).toBeUndefined();
  expect(readCanary([marker, user, asst({ cacheRead: 0, cacheWrite: 9_000 })])).toBeUndefined();
  expect(readCanary([user, parent, marker, user, asst({ cacheRead: 1 }), user, asst({ cacheRead: 2 })])).toBeUndefined();
});

test("a model switch is recorded but not flagged", () => {
  const r = readCanary([user, parent, marker, user, asst({ cacheRead: 0, cacheWrite: 180_000 }, "haiku")])!;
  expect(r.miss).toBe(false);
  expect(r.model).toBe("haiku");
});

test("recordCanary appends one JSON line", () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-"));
  try {
    recordCanary(dir, "fork-1", readCanary([user, parent, marker, user, asst({ cacheRead: 7_243, cacheWrite: 175_000 })])!, new Date(0));
    const line = JSON.parse(readFileSync(join(dir, "fork-cache-canary.jsonl"), "utf8").trim());
    expect(line).toMatchObject({ forkId: "fork-1", miss: true, ratio: 0.04 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
