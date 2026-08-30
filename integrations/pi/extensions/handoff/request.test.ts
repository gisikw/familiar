import { describe, expect, test } from "bun:test";
import { handoffMaxTokens } from "./request.ts";

describe("handoff completion compatibility", () => {
  test("omits max tokens for direct Tiamat Codex Responses calls", () => {
    expect(handoffMaxTokens("tiamat-responses-codex-personal", 16_384)).toBeUndefined();
  });

  test("retains bounded handoff output for other providers", () => {
    expect(handoffMaxTokens("tiamat-anthropic-claude-code-personal", 16_384)).toBe(16_384);
    expect(handoffMaxTokens("anthropic", 8_192)).toBe(8_192);
  });
});
