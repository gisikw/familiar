// anthropic-body.test.ts + runner env-scrub tests. Run:
//   nix develop .#stt -c bun test extensions/lib/anthropic-body.test.ts
import { expect, test, describe } from "bun:test";
import { parseAnthropicBody, systemToString } from "./anthropic-body.ts";
import { buildEnv, buildArgs } from "./claude-runner.ts";

describe("systemToString", () => {
  test("string passthrough", () => expect(systemToString("hi")).toBe("hi"));
  test("array of text fragments joined", () =>
    expect(systemToString([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\n\nb"));
  test("undefined → empty", () => expect(systemToString(undefined)).toBe(""));
});

describe("parseAnthropicBody", () => {
  test("string user content", () => {
    const p = parseAnthropicBody({ messages: [{ role: "user", content: "hello" }] });
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "hello" }] });
  });

  test("tool_result splits into its own role:tool message BEFORE trailing text", () => {
    const p = parseAnthropicBody({
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "42", is_error: false },
            { type: "text", text: "thanks" },
          ],
        },
      ],
    });
    expect(p.messages.map((m) => m.role)).toEqual(["tool", "user"]);
    expect(p.messages[0].content[0]).toMatchObject({ type: "tool_result", toolResultFor: "toolu_1", toolOutput: "42", isError: false });
    expect(p.messages[1].content[0]).toMatchObject({ type: "text", text: "thanks" });
  });

  test("tool_result with array content flattens text blocks", () => {
    const p = parseAnthropicBody({
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "x" }, { type: "text", text: "y" }] }] }],
    });
    expect(p.messages[0].content[0].toolOutput).toBe("x\ny");
  });

  test("assistant tool_use preserved", () => {
    const p = parseAnthropicBody({
      messages: [{ role: "assistant", content: [{ type: "text", text: "let me" }, { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] }],
    });
    expect(p.messages[0].content).toEqual([
      { type: "text", text: "let me" },
      { type: "tool_use", toolUseId: "t1", toolName: "bash", toolInput: { command: "ls" } },
    ]);
  });

  test("image block carried through", () => {
    const p = parseAnthropicBody({
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }],
    });
    expect(p.messages[0].content[0]).toMatchObject({ type: "image", imageData: "AAAA", imageMediaType: "image/png" });
  });

  test("system + model + stream flags surfaced", () => {
    const p = parseAnthropicBody({ model: "claude-opus-4-8", system: "sys", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(p.system).toBe("sys");
    expect(p.model).toBe("claude-opus-4-8");
    expect(p.stream).toBe(true);
  });
});

describe("runner buildEnv — ANTHROPIC_* scrub (critical: tiamat env must not leak)", () => {
  test("strips all inherited ANTHROPIC_* and sets CLAUDE_CONFIG_DIR", () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "leak";
    process.env.ANTHROPIC_BASE_URL = "https://tiamat.example/anthropic/managed";
    process.env.ANTHROPIC_AUTH_TOKEN = "leak2";
    process.env.FAMILIAR_ANTHROPIC_OAUTH = "retired-json-must-not-reach-child";
    process.env.FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN = "source-must-not-reach-child";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-must-not-reach-child";
    try {
      const env = buildEnv({ stdin: "", configDir: "/tmp/cfg", oauthToken: "explicit-child-token" });
      expect(Object.keys(env).some((k) => k.startsWith("ANTHROPIC_") && k !== "ANTHROPIC_BASE_URL")).toBe(false);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.FAMILIAR_ANTHROPIC_OAUTH).toBeUndefined();
      expect(env.FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("explicit-child-token");
      expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/cfg");
    } finally {
      process.env = saved;
    }
  });

  test("sets claude-facing ANTHROPIC_BASE_URL only when provided (loopback B)", () => {
    const a = buildEnv({ stdin: "", configDir: "/tmp/cfg" });
    expect(a.ANTHROPIC_BASE_URL).toBeUndefined();
    const b = buildEnv({ stdin: "", configDir: "/tmp/cfg", claudeBaseUrl: "http://127.0.0.1:9/x" });
    expect(b.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9/x");
  });
});

describe("runner buildArgs", () => {
  test("v0 defaults", () => {
    expect(buildArgs({ stdin: "", configDir: "" })).toEqual([
      "-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--permission-mode", "default",
    ]);
  });
  test("resume + model + mcp + allowedTools + stream-json input", () => {
    const a = buildArgs({ stdin: "", configDir: "", resume: "sid", model: "claude-opus-4-8", mcpConfigFile: "m.json", allowedTools: ["mcp__pi__bash", "mcp__pi__read"], streamJsonInput: true });
    expect(a).toContain("--input-format");
    expect(a).toContain("--resume");
    expect(a).toContain("sid");
    expect(a).toContain("--model");
    expect(a).toContain("--strict-mcp-config");
    expect(a).toContain("--allowedTools=mcp__pi__bash,mcp__pi__read");
  });
});
