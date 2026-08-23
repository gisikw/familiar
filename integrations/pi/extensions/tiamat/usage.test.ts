import { describe, expect, test } from "bun:test";
import { formatUsage, isProviders, providerId } from "./usage.ts";

const windows = [
  { name: "session", used: "33%", resetsIn: "3h", resetsInSeconds: 10_800 },
  { name: "weekly", used: "27%", resetsIn: "5d", resetsInSeconds: 432_000 },
];

describe("Tiamat provider usage", () => {
  test("parses encoded provider ids and rejects unrelated providers", () => {
    expect(providerId("tiamat-responses-codex%2Fpersonal")).toBe("codex/personal");
    expect(providerId("anthropic")).toBeUndefined();
  });

  test("formats compact windows and tones constrained or stale usage", () => {
    expect(formatUsage("claude-code-personal", windows, false)).toEqual({
      text: "claude 5h 33% · 7d 27%", tone: "dim",
    });
    expect(formatUsage("codex-personal", [{ ...windows[0], used: "90%" }], false))
      .toEqual({ text: "△ codex 5h 90%", tone: "warning" });
    expect(formatUsage("codex-personal", [{ ...windows[0], used: "100%" }], false)?.tone).toBe("error");
    expect(formatUsage("claude-code-personal", windows, true)?.text).toEndWith(" · stale");
  });

  test("validates provider payloads defensively", () => {
    expect(isProviders({ personal: { usage: { windows } } })).toBe(true);
    expect(isProviders({ personal: { usage: { windows: [{ name: "weekly", used: 20 }] } } })).toBe(false);
  });
});
