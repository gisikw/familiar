import { describe, expect, test } from "bun:test";
import { contextSaturation } from "./saturation.ts";

const model = { contextWindow: 200_000 };

describe("Familiar context saturation telemetry", () => {
  test("uses Pi's current context usage after a turn", () => {
    const ctx = {
      model,
      getContextUsage: () => ({ tokens: 50_000, contextWindow: 100_000, percent: 50 }),
    };
    const message = { role: "assistant", usage: { totalTokens: 190_000 } };
    expect(contextSaturation(ctx as never, message)).toBe(0.5);
  });

  test("falls back to actual turn usage when Pi has no direct token value", () => {
    const ctx = {
      model,
      getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
    };
    expect(contextSaturation(ctx as never, {
      role: "assistant", usage: { totalTokens: 180_000 },
    })).toBe(0.9);
    expect(contextSaturation(ctx as never, { role: "assistant" })).toBeUndefined();
  });

  test("derives provider usage components against model.contextWindow, never text length", () => {
    const ctx = { model, getContextUsage: undefined };
    expect(contextSaturation(ctx as never, {
      role: "assistant",
      usage: { input: 20_000, output: 5_000, cacheRead: 70_000, cacheWrite: 5_000 },
    })).toBe(0.5);
    expect(contextSaturation(ctx as never, { role: "assistant" })).toBeUndefined();
  });

  test("clamps an overflow ratio to Hearth's 0...1 domain", () => {
    const ctx = {
      model,
      getContextUsage: () => ({ tokens: 220_000, contextWindow: 200_000, percent: 110 }),
    };
    expect(contextSaturation(ctx as never)).toBe(1);
  });
});
