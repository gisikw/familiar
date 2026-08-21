import { describe, expect, test } from "bun:test";
import { anthropicBody, codexBody, extractAnthropic } from "./ratelimit.ts";

describe("rate-limit provider coexistence", () => {
  test("labels Claude separately from Codex subscription quota", () => {
    const claude = extractAnthropic(200, {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.2",
    }, 0)!;
    expect(anthropicBody(claude)).toBe("Claude 5h 20% used");
    expect(codexBody({ source: "endpoint", fetchedAt: 0, windows: [{ usedPercent: 15, windowSeconds: 604800, resetAt: 86_400_000 }] }, false, 0))
      .toBe("Codex 1w 15% used/85% left reset 1d");
  });

  test("marks retained Codex data stale without converting request tokens", () => {
    const text = codexBody({ source: "endpoint", fetchedAt: 0, windows: [{ usedPercent: 90, windowSeconds: 18000 }] }, true, 0)!;
    expect(text).toBe("Codex 5h 90% used/10% left · stale");
    expect(text).not.toContain("token");
  });
});
