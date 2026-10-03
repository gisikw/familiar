import { expect, test } from "bun:test";
import { renderRestartNotice, RESTARTED } from "./index.ts";

test("restart notice names the build and says when nothing was missed", () => {
  const n = renderRestartNotice({ at: new Date("2026-10-01T07:00:00Z"), sha: "622001154a140c34", redelivered: 0 });
  expect(n.customType).toBe(RESTARTED);
  expect(n.content).toContain('familiar="6220011"');
  expect(n.content).toContain("no missed scheduled events");
});

test("restart notice counts redeliveries", () => {
  const n = renderRestartNotice({ at: new Date(), sha: "", redelivered: 2 });
  expect(n.content).toContain('familiar="unknown"');
  expect(n.content).toContain("2 scheduled events redelivered");
});

// Oct 3: a restart that only redelivered a soft/fork/quiet event sent the
// notice as nextTurn, so it waited ~10 min for Kev instead of waking the
// session. The notice is a wake unless a redelivered wake already started one.
test("restart notice wakes the session even after soft redeliveries", async () => {
  const { restartNoticeDelivery } = await import("./index.ts");
  expect(restartNoticeDelivery(false)).toEqual({ deliverAs: "steer", triggerTurn: true });
});

test("restart notice rides along when a redelivered wake already started a turn", async () => {
  const { restartNoticeDelivery } = await import("./index.ts");
  const d = restartNoticeDelivery(true);
  expect(d.deliverAs).toBe("steer");
  expect(d.triggerTurn).toBe(false);
});
