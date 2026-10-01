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
