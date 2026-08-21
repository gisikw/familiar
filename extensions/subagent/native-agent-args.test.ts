import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { nativeAgentArgs } from "./native-agent-args.ts";

// The native (pi) subagent boots with `--no-extensions` and an explicit `-e`
// list, so the child's provider route is composed entirely here. These tests
// pin the exact child extension SET and ORDER, because that order is what
// decides provider authority: pi loads `-e` paths in argv order and applies
// same-id provider registrations last-writer-wins (see index.ts nativeAgentArgs
// doc block, verified against pi 0.84.x extensions/loader.ts + model-runtime.ts).

const EXT = "/repo/extensions";
const p = (name: string) => path.join(EXT, name, "index.ts");

const baseOpts = { extDir: EXT, sessionDir: "/sessions", sessionId: "sess-123" };

describe("nativeAgentArgs — child extension set and order", () => {
  test("loads exactly anthropic-gateway, claude-driver, web (in that order)", () => {
    const args = nativeAgentArgs(baseOpts);
    // Extract the ordered list of `-e` paths.
    const loaded: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-e") loaded.push(args[i + 1]);
    }
    expect(loaded).toEqual([
      p("anthropic-gateway"),
      p("claude-driver"),
      p("web"),
    ]);
  });

  test("claude-driver loads AFTER anthropic-gateway (authority inversion)", () => {
    const args = nativeAgentArgs(baseOpts);
    const gatewayIdx = args.indexOf(p("anthropic-gateway"));
    const driverIdx = args.indexOf(p("claude-driver"));
    expect(gatewayIdx).toBeGreaterThanOrEqual(0);
    expect(driverIdx).toBeGreaterThanOrEqual(0);
    // Later `-e` wins provider authority for the same id: claude-driver must
    // come strictly after anthropic-gateway so its loopback route overrides
    // tiamat's fallback route when canonical creds are present.
    expect(driverIdx).toBeGreaterThan(gatewayIdx);
  });

  test("web is preserved and remains route-neutral (registers no provider)", () => {
    const args = nativeAgentArgs(baseOpts);
    expect(args).toContain(p("web"));
    // web is last among the -e triple; its position does not affect provider
    // authority but we pin it so a reorder is a conscious decision.
    const loaded = args.filter((_, i) => args[i - 1] === "-e");
    expect(loaded[loaded.length - 1]).toBe(p("web"));
  });

  test("starts with --no-extensions so discovery cannot inject a provider", () => {
    const args = nativeAgentArgs(baseOpts);
    expect(args[0]).toBe("--no-extensions");
    // No ambient discovery: the only providers the child sees are the three we
    // name. A stray project-local extension cannot silently seize `anthropic`.
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
    // --model rides at the tail, after the extension and isolation flags.
    expect(withModel.indexOf("--model")).toBeGreaterThan(withModel.indexOf("--session-id"));
  });
});
