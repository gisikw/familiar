import { describe, expect, test } from "bun:test";
import { formatReset, formatUsage, isProviders, providerId } from "./usage.ts";

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
    const now = Date.UTC(2026, 7, 23, 4, 0, 0);
    expect(formatUsage("claude-code-personal", windows, false, now, "UTC")).toEqual({
      text: "claude 5h 33% ↻3h · 7d 27% ↻Fri 4:00am", tone: "dim",
    });
    expect(formatUsage("codex-personal", [{ ...windows[0], used: "90%" }], false, now, "UTC"))
      .toEqual({ text: "△ codex 5h 90% ↻3h", tone: "warning" });
    expect(formatUsage("codex-personal", [{ ...windows[0], used: "100%" }], false, now, "UTC")?.tone).toBe("error");
    expect(formatUsage("claude-code-personal", windows, true, now, "UTC")?.text).toEndWith(" · stale");
  });

  test("resets render relative under 12h and absolute weekday beyond", () => {
    const now = Date.UTC(2026, 7, 23, 4, 0, 0); // Sunday 04:00 UTC
    expect(formatReset(9_000, now, "UTC")).toBe("2h 30m");
    expect(formatReset(3_600, now, "UTC")).toBe("1h");
    expect(formatReset(120, now, "UTC")).toBe("2m");
    expect(formatReset(2 * 86_400, now, "UTC")).toBe("Tue 4:00am");
    expect(formatReset(2 * 86_400, now, "America/Chicago")).toBe("Mon 11:00pm");
    expect(formatReset(0, now, "UTC")).toBeUndefined();
    expect(formatReset(Number.NaN, now, "UTC")).toBeUndefined();
  });

  test("validates provider payloads defensively", () => {
    expect(isProviders({ personal: { usage: { windows } } })).toBe(true);
    expect(isProviders({ personal: { usage: { windows: [{ name: "weekly", used: 20 }] } } })).toBe(false);
  });
});
