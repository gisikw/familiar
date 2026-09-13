import { expect, test } from "bun:test";
import { impGuidance, stuffGuidance } from "./guidance.ts";

test("use_stuff adds a compact self-discovery nudge to identity", () => {
  const guidance = stuffGuidance("true");
  expect(guidance).toContain("`stuff` CLI stores inert Items and linked Notes");
  expect(guidance).toContain("`stuff --help`");
  expect(guidance).toContain("does not dispatch or orchestrate");
});

test("Stuff nudge is opt-in and requires canonical true", () => {
  expect(stuffGuidance("")).toBe("");
  expect(stuffGuidance("false")).toBe("");
  expect(stuffGuidance("TRUE")).toBe("");
});

test("Imp guidance advertises only a live shell-native surface", () => {
  expect(impGuidance("", "/tmp/imp.sock")).toBe("");
  expect(impGuidance("/nix/store/imp/bin", "")).toBe("");

  const guidance = impGuidance("/nix/store/imp/bin", "/tmp/imp.sock");
  expect(guidance).toContain("`imp plate`");
  expect(guidance).toContain("`imp agent`");
  expect(guidance).toContain("prefer the advertised Golem tools");
  expect(guidance).toContain("Never silently fall back between agent systems");
});
