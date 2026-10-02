import { afterEach, expect, test } from "bun:test";
import { deliveredIds, forkRequest, hiddenForkIds, isNothingReturn, QUIET_MERGE, quietMergeRecord, renderScheduledEvent, resetHiddenForks, SCHEDULED_FORK } from "./index.ts";

afterEach(() => resetHiddenForks());

const mergeOf = (summary: string, forkSessionId = "presence-1") => ({ id: `m-${summary}`, due_at: 1, target: "instance:parent", origin: forkSessionId, source: "imp.merge", priority: 2, type: "merge", summary, body: JSON.stringify({ summary, forkSessionId, forkSessionFile: "/state/p.jsonl", branchEntryId: "b", firstEntryId: "f", lastEntryId: "l", turnCount: 2, forkedFurther: false, mergedAt: "2026-10-02T18:00:00Z" }), urgency: "soft" as const, state: "delivered" as const, created_at: 1 });

test("forkRequest carries hidden", () => {
  const ev = { ...mergeOf("x"), type: "fork", body: JSON.stringify({ task: "reach?", label: "presence", hidden: true }) };
  expect(forkRequest(ev).hidden).toBe(true);
});

test("a hidden fork's merge stays in the record but out of the display", () => {
  resetHiddenForks(["presence-1"]);
  expect(renderScheduledEvent(mergeOf("presence: pushed him a line at 14:10")).display).toBe(false);
  expect(renderScheduledEvent(mergeOf("did a thing", "other")).display).toBe(true);
});

test("a hidden fork's 'nothing' merge becomes a record-only entry and counts as delivered", () => {
  resetHiddenForks(["presence-1"]);
  const rec = quietMergeRecord(mergeOf("Nothing."));
  expect(rec?.forkId).toBe("presence-1");
  expect(quietMergeRecord(mergeOf("nothing", "other"))).toBeUndefined();
  expect(quietMergeRecord(mergeOf("presence: pushed"))).toBeUndefined();
  expect([...deliveredIds([{ type: "custom", customType: QUIET_MERGE, data: rec }])]).toEqual(["m-Nothing."]);
});

test("nothing-return matcher is strict", () => {
  expect(isNothingReturn(" nothing ")).toBe(true);
  expect(isNothingReturn("nothing to report, but")).toBe(false);
});

test("hidden fork ids rebuild from the branch", () => {
  expect(hiddenForkIds([
    { type: "custom", customType: SCHEDULED_FORK, data: { id: "e1", forkId: "a", hidden: true } },
    { type: "custom", customType: SCHEDULED_FORK, data: { id: "e2", forkId: "b" } },
  ])).toEqual(["a"]);
});
