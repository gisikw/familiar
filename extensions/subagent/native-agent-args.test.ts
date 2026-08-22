import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { nativeAgentArgs } from "./native-agent-args.ts";

const EXT = "/repo/extensions";
const p = (name: string) => path.join(EXT, name, "index.ts");
const baseOpts = { extDir: EXT, sessionDir: "/sessions", sessionId: "sess-123" };

describe("nativeAgentArgs — child extension set", () => {
  test("loads exactly anthropic-gateway and web", () => {
    const args = nativeAgentArgs(baseOpts);
    const loaded = args.filter((_, i) => args[i - 1] === "-e");
    expect(loaded).toEqual([p("anthropic-gateway"), p("web")]);
  });

  test("external gateway is the sole Anthropic routing extension", () => {
    const args = nativeAgentArgs(baseOpts);
    expect(args).toContain(p("anthropic-gateway"));
    expect(args.some((arg) => arg.includes("claude-driver"))).toBe(false);
  });

  test("web is preserved and remains route-neutral", () => {
    const args = nativeAgentArgs(baseOpts);
    expect(args).toContain(p("web"));
    const loaded = args.filter((_, i) => args[i - 1] === "-e");
    expect(loaded[loaded.length - 1]).toBe(p("web"));
  });

  test("starts with --no-extensions so discovery cannot inject a provider", () => {
    const args = nativeAgentArgs(baseOpts);
    expect(args[0]).toBe("--no-extensions");
    expect(args).not.toContain("--extensions");
  });

  test("preserves isolation flags and session identity", () => {
    const args = nativeAgentArgs(baseOpts);
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-context-files");
    expect(args[args.indexOf("--session-dir") + 1]).toBe("/sessions");
    expect(args[args.indexOf("--session-id") + 1]).toBe("sess-123");
  });

  test("model is appended only when supplied", () => {
    expect(nativeAgentArgs(baseOpts)).not.toContain("--model");
    const withModel = nativeAgentArgs({ ...baseOpts, model: "anthropic/claude-haiku-4-5" });
    expect(withModel[withModel.indexOf("--model") + 1]).toBe("anthropic/claude-haiku-4-5");
    expect(withModel.indexOf("--model")).toBeGreaterThan(withModel.indexOf("--session-id"));
  });
});
