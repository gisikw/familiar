import { expect, test } from "bun:test";

import { laneOf, loadBoard, moveItem, type ExecResult, type StuffExec, type StuffItem } from "./stuff.ts";

const batch: StuffItem = {
  id: "item_batch",
  name: "Release batch",
  revision: "1-batch",
  metadata: { item_ids: ["item_one", "item_two", "item_one"] },
};
const one: StuffItem = {
  id: "item_one",
  name: "First card",
  revision: "2-one",
  metadata: { status: "in_progress", owner: "sam" },
};
const two: StuffItem = {
  id: "item_two",
  name: "Second card",
  revision: "1-two",
  metadata: {},
};

function result(value: unknown): ExecResult {
  return { stdout: JSON.stringify(value), stderr: "", code: 0 };
}

test("loads the batch item_ids with the current stuff get contract", async () => {
  const records = new Map([batch, one, two].map((item) => [item.id, item]));
  const calls: string[][] = [];
  const exec: StuffExec = async (command, args) => {
    calls.push([command, ...args]);
    return result(records.get(args[1]!));
  };

  const board = await loadBoard(batch.id, { exec });
  expect(board.items.map((item) => item.id)).toEqual([one.id, two.id]);
  expect(calls).toEqual([
    ["stuff", "get", batch.id],
    ["stuff", "get", one.id],
    ["stuff", "get", two.id],
  ]);
  expect(laneOf(two)).toBe("open");
});

test("rejects a batch without a valid metadata.item_ids projection", async () => {
  const bad = { ...batch, metadata: { item_ids: ["item_ok", "not-an-item"] } };
  expect(loadBoard(batch.id, { exec: async () => result(bad) }))
    .rejects.toThrow("metadata.item_ids");
});

test("lane moves preserve metadata and use the loaded optimistic revision", async () => {
  let call: string[] = [];
  const updated = { ...one, revision: "3-one", metadata: { ...one.metadata, status: "ready_for_review" } };
  const moved = await moveItem(async (command, args) => {
    call = [command, ...args];
    return result(updated);
  }, one, "ready_for_review");

  expect(call.slice(0, 3)).toEqual(["stuff", "update", one.id]);
  expect(call[call.indexOf("--revision") + 1]).toBe("2-one");
  expect(JSON.parse(call[call.indexOf("--meta") + 1]!)).toEqual({
    status: "ready_for_review",
    owner: "sam",
  });
  expect(moved.revision).toBe("3-one");
});

test("failed revision-safe moves surface the CLI conflict", async () => {
  const exec: StuffExec = async () => ({ stdout: "", stderr: "revision conflict: stale", code: 1 });
  expect(moveItem(exec, one, "done")).rejects.toThrow("revision conflict");
});
