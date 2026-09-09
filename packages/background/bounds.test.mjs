import test from "node:test";
import assert from "node:assert/strict";
import {
  bounded,
  LIMITS,
  report,
  reportData,
  mergeContent,
} from "./protocol.mjs";

test("a maximal accepted report still replays and merges after internal packet metadata is added", () => {
  const value = report({
    reportId: "edge",
    disposition: "ready",
    requestedRejoin: true,
    summary: "s".repeat(8000),
    decisions: Array(10).fill("d".repeat(2000)),
    durableContext: ["x".repeat(2048), "x".repeat(2048)],
    risks: [""],
  });
  const remaining =
    LIMITS.packetBytes - Buffer.byteLength(JSON.stringify(value));
  assert.ok(remaining >= 0 && remaining <= 2048);
  value.risks[0] = "r".repeat(remaining);
  assert.equal(Buffer.byteLength(JSON.stringify(value)), LIMITS.packetBytes);
  const normalized = report(value);
  const saved = { ...normalized, packetId: "internal-packet", run: 1 };
  assert.deepEqual(report(reportData(saved)), normalized);
  const content = mergeContent(
    {
      id: "branch",
      generation: 1,
      admission: { parentSessionId: "parent", parentLeafId: "leaf" },
      foregroundUserEntryId: "user",
      foregroundControlEntryId: "control",
      archive: {
        sessionId: "archive",
        file: "/archive",
        sha256: "0".repeat(64),
      },
    },
    saved,
    "control",
  );
  assert.equal(JSON.parse(content).summary, normalized.summary);
  assert.ok(Buffer.byteLength(content) <= LIMITS.packetBytes + 8192);
});

test("progressive budgets preserve native JSON and accept its exact byte boundary", () => {
  const shared = { text: "shared" };
  for (const value of [
    null,
    false,
    true,
    0,
    -12.5,
    NaN,
    "",
    'quote"\n\u0000λ🚀',
    [],
    {},
    [undefined, , "x"],
    { absent: undefined, fn() {}, kept: true },
    { "": {}, nested: [{ a: 1 }, { b: "two" }] },
    { a: shared, b: shared },
    new Date(0),
    Buffer.from("text"),
    new String("boxed"),
  ]) {
    const json = JSON.stringify(value);
    const bytes = Buffer.byteLength(json);
    assert.equal(bounded(value, bytes, "test"), json);
    assert.throws(() => bounded(value, bytes - 1, "test"), /byte budget/);
  }
});

test("oversized context stops before later fields or a huge sparse array are traversed", () => {
  let visited = false;
  const context = {
    content: "x".repeat(1024 * 1024),
    get later() {
      visited = true;
      throw new Error("must not traverse");
    },
  };
  assert.throws(() => bounded(context, 1024, "context"), /byte budget/);
  assert.equal(visited, false);
  const array = [];
  array.length = 1_000_000_000;
  assert.throws(() => bounded(array, 1024, "array"), /byte budget/);
});
