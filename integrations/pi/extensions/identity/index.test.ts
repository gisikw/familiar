import { expect, test } from "bun:test";
import { stuffGuidance } from "./guidance.ts";

test("use_stuff adds a compact self-discovery nudge to identity", () => {
  const guidance = stuffGuidance("true");
  expect(guidance).toContain("`stuff` CLI stores inert Items and linked Notes");
  expect(guidance).toContain("`stuff --help`");
  expect(guidance).toContain("does not dispatch or orchestrate");
});

test("Stuff nudge is opt-in and requires canonical true", () => {
  expect(stuffGuidance(undefined)).toBe("");
  expect(stuffGuidance("false")).toBe("");
  expect(stuffGuidance("TRUE")).toBe("");
});
