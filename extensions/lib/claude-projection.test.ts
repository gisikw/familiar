// claude-projection.test.ts — TS port of tiamat's turn/claude_jsonl_test.go.
// These are the SPEC for the deterministic projection. Run:
//   nix develop .#stt -c bun test extensions/lib/claude-projection.test.ts
import { expect, test, describe } from "bun:test";
import {
  projectClaudeCodeJSONL,
  appendToolResultResumeGuard,
  uuidFromString,
  sessionIdFromSeed,
  messagesForProjection,
  rewriteToolNamesForProjection,
  claudeProjectKey,
  claudeModelArg,
  CONTINUATION_PROMPT,
  type Message,
  type ProjectionOptions,
} from "./claude-projection.ts";

const OPTS: ProjectionOptions = {
  sessionId: "55555555-5555-5555-8555-555555555555",
  cwd: "/home/dev/Projects/tiamat",
  gitBranch: "main",
  version: "2.1.62",
};

function rows(jsonl: string): Record<string, any>[] {
  return jsonl
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("projectClaudeCodeJSONL", () => {
  test("text-only fixture (request-minimal)", () => {
    const messages: Message[] = [
      { id: "fixture-msg-1", createdAt: "2026-06-20T15:30:00Z", role: "user", content: [{ type: "text", text: "Use bash to print hello." }] },
    ];
    const r = rows(projectClaudeCodeJSONL(messages, OPTS));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      parentUuid: null,
      isSidechain: false,
      userType: "external",
      cwd: "/home/dev/Projects/tiamat",
      sessionId: OPTS.sessionId,
      version: "2.1.62",
      gitBranch: "main",
      type: "user",
      message: { role: "user", content: "Use bash to print hello." },
      timestamp: "2026-06-20T15:30:00.000Z",
      permissionMode: "default",
    });
    // deterministic uuid derived from the message id
    expect(r[0].uuid).toBe(uuidFromString("tiamat.claude_code.row_uuid.v1:fixture-msg-1"));
  });

  test("after-tool-result fixture: user → assistant(tool_use) → tool_result", () => {
    const messages: Message[] = [
      { id: "4ba97a9c-eea2-42f1-b0d4-fa79e3d82585", createdAt: "2026-06-20T15:30:00Z", role: "user", content: [{ type: "text", text: "Use bash to print hello." }], provenance: { origin: "cranium" } },
      { id: "ab893c13-f25a-4e26-843f-567550b677e6", parentId: "4ba97a9c-eea2-42f1-b0d4-fa79e3d82585", createdAt: "2026-06-20T15:30:02Z", role: "assistant", content: [{ type: "tool_use", toolUseId: "toolu_tiamat_20260620153002000000", toolName: "bash", toolInput: { command: "printf hello" } }], provenance: { origin: "tiamat", backend: "claude_code", provider: "anthropic", model: "claude_code" } },
      { id: "6071f60e-1f63-4e98-8b45-bacf6afe6e72", parentId: "ab893c13-f25a-4e26-843f-567550b677e6", createdAt: "2026-06-20T15:30:05Z", role: "tool", content: [{ type: "tool_result", toolResultFor: "toolu_tiamat_20260620153002000000", toolOutput: { stdout: "hello", stderr: "", exit_code: 0 }, isError: false }], provenance: { origin: "cranium" } },
    ];
    const r = rows(projectClaudeCodeJSONL(messages, OPTS));
    expect(r).toHaveLength(3);
    // user row: uuid == id (real uuid preserved)
    expect(r[0].uuid).toBe("4ba97a9c-eea2-42f1-b0d4-fa79e3d82585");
    // assistant row
    expect(r[1]).toMatchObject({
      parentUuid: "4ba97a9c-eea2-42f1-b0d4-fa79e3d82585",
      type: "assistant",
      requestId: "req_synthetic_ab893c13-f25a-4e26-843f-567550b677e6",
      uuid: "ab893c13-f25a-4e26-843f-567550b677e6",
      timestamp: "2026-06-20T15:30:02.000Z",
    });
    expect(r[1].message).toMatchObject({
      id: "msg_synthetic_ab893c13-f25a-4e26-843f-567550b677e6",
      type: "message",
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "tool_use", id: "toolu_tiamat_20260620153002000000", name: "bash", input: { command: "printf hello" } }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    // tool_result user row: content is the compact canonical JSON string with SORTED keys
    expect(r[2].message.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_tiamat_20260620153002000000", content: '{"exit_code":0,"stderr":"","stdout":"hello"}', is_error: false },
    ]);
    expect(r[2].sourceToolAssistantUUID).toBe("ab893c13-f25a-4e26-843f-567550b677e6");
    expect(r[2].toolUseResult).toEqual({ stdout: "hello", stderr: "", interrupted: false, isImage: false, noOutputExpected: false });
    expect(r[2].parentUuid).toBe("ab893c13-f25a-4e26-843f-567550b677e6");
  });

  test("preserves anthropic provenance (model/id/requestId)", () => {
    const messages: Message[] = [
      { id: "11111111-1111-4111-8111-111111111111", role: "assistant", createdAt: "2026-06-20T15:30:00Z", content: [{ type: "text", text: "done" }], provenance: { origin: "tiamat", backend: "claude_code", provider: "anthropic", model: "claude-sonnet-4-20250514", providerMessageID: "msg_01provider", providerRequestID: "req_01provider" } },
    ];
    const r = rows(projectClaudeCodeJSONL(messages, OPTS));
    expect(r[0].message.model).toBe("claude-sonnet-4-20250514");
    expect(r[0].message.id).toBe("msg_01provider");
    expect(r[0].requestId).toBe("req_01provider");
  });

  test("splits assistant text and tool_use into separate rows w/ chained parents", () => {
    const messages: Message[] = [
      { id: "assistant-1", role: "assistant", createdAt: "2026-06-20T15:30:00Z", content: [{ type: "text", text: "File two." }, { type: "tool_use", toolUseId: "toolu_1", toolName: "mcp__tiamat__write", toolInput: { path: "/tmp/bravo" } }] },
      { id: "tool-result-1", parentId: "assistant-1", role: "tool", createdAt: "2026-06-20T15:30:01Z", content: [{ type: "tool_result", toolResultFor: "toolu_1", toolOutput: { ok: true } }] },
    ];
    const r = rows(projectClaudeCodeJSONL(messages, OPTS));
    expect(r).toHaveLength(3);
    expect(r[0].message.stop_reason).toBe("end_turn");
    expect(r[1].message.stop_reason).toBe("tool_use");
    expect(r[1].parentUuid).toBe(r[0].uuid);
    expect(r[2].parentUuid).toBe(r[1].uuid);
    expect(r[2].sourceToolAssistantUUID).toBe(r[1].uuid);
  });

  test("spreads sub-millisecond rows for resume (monotonic +1ms)", () => {
    const messages: Message[] = [
      { id: "assistant-1", role: "assistant", createdAt: "2026-06-20T15:30:00.000001Z", content: [{ type: "tool_use", toolUseId: "toolu_1", toolName: "mcp__tiamat__write", toolInput: { path: "/tmp/one" } }] },
      { id: "tool-result-1", parentId: "assistant-1", role: "tool", createdAt: "2026-06-20T15:30:00.000002Z", content: [{ type: "tool_result", toolResultFor: "toolu_1", toolOutput: { ok: 1 } }] },
      { id: "assistant-2", parentId: "tool-result-1", role: "assistant", createdAt: "2026-06-20T15:30:00.000003Z", content: [{ type: "tool_use", toolUseId: "toolu_2", toolName: "mcp__tiamat__write", toolInput: { path: "/tmp/two" } }] },
      { id: "tool-result-2", parentId: "assistant-2", role: "tool", createdAt: "2026-06-20T15:30:00.000004Z", content: [{ type: "tool_result", toolResultFor: "toolu_2", toolOutput: { ok: 2 } }] },
    ];
    const r = rows(projectClaudeCodeJSONL(messages, OPTS));
    expect(r.map((x) => x.timestamp)).toEqual([
      "2026-06-20T15:30:00.000Z",
      "2026-06-20T15:30:00.001Z",
      "2026-06-20T15:30:00.002Z",
      "2026-06-20T15:30:00.003Z",
    ]);
  });

  test("rejects opaque unsupported content (image without data)", () => {
    expect(() =>
      projectClaudeCodeJSONL([{ role: "user", createdAt: "2026-06-20T15:30:00Z", content: [{ type: "image" }] }], OPTS),
    ).toThrow();
  });

  test("byte-determinism: same input → identical bytes", () => {
    const messages: Message[] = [
      { id: "assistant-1", role: "assistant", createdAt: "2026-06-20T15:30:00Z", content: [{ type: "text", text: "hi" }] },
    ];
    expect(projectClaudeCodeJSONL(messages, OPTS)).toBe(projectClaudeCodeJSONL(messages, OPTS));
  });
});

describe("appendToolResultResumeGuard", () => {
  test("adds soft meta leaf after a tool_result leaf", () => {
    const messages: Message[] = [
      { id: "assistant-1", role: "assistant", createdAt: "2026-06-20T15:30:00Z", content: [{ type: "tool_use", toolUseId: "toolu_1", toolName: "mcp__tiamat__lookup", toolInput: { q: "x" } }] },
      { id: "tool-result-1", parentId: "assistant-1", role: "tool", createdAt: "2026-06-20T15:30:01Z", content: [{ type: "tool_result", toolResultFor: "toolu_1", toolOutput: { ok: true } }] },
    ];
    const proj = projectClaudeCodeJSONL(messages, OPTS);
    const { projection, appended } = appendToolResultResumeGuard(proj, OPTS);
    expect(appended).toBe(true);
    const r = rows(projection);
    expect(r).toHaveLength(3);
    expect(r[2].parentUuid).toBe(r[1].uuid);
    expect(r[2].isMeta).toBe(true);
    expect(r[2].message.content).toBe(CONTINUATION_PROMPT);
    expect(r[2].message.content).not.toBe("Continue from where you left off.");
  });

  test("skips non-tool-result leaf", () => {
    const messages: Message[] = [
      { id: "user-1", role: "user", createdAt: "2026-06-20T15:30:00Z", content: [{ type: "text", text: "hello" }] },
    ];
    const proj = projectClaudeCodeJSONL(messages, OPTS);
    const { projection, appended } = appendToolResultResumeGuard(proj, OPTS);
    expect(appended).toBe(false);
    expect(projection).toBe(proj);
  });
});

describe("v1b helpers (session id / trim / tool-rewrite / project key / model arg)", () => {
  test("sessionIdFromSeed is deterministic and UUID-shaped (version nibble 5)", () => {
    const a = sessionIdFromSeed("conv:abc");
    const b = sessionIdFromSeed("conv:abc");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessionIdFromSeed("conv:xyz")).not.toBe(a);
  });

  test("messagesForProjection drops a trailing user message, keeps trailing tool", () => {
    const u = (id: string): Message => ({ id, role: "user", content: [{ type: "text", text: id }] });
    const t = (id: string): Message => ({ id, role: "tool", content: [{ type: "tool_result", toolResultFor: "x", toolOutput: "y" }] });
    expect(messagesForProjection([u("a"), u("b")]).map((m) => m.id)).toEqual(["a"]);
    expect(messagesForProjection([u("a"), t("b")]).map((m) => m.id)).toEqual(["a", "b"]);
    expect(messagesForProjection([])).toEqual([]);
  });

  test("rewriteToolNamesForProjection prefixes only allowed, non-mcp assistant tool_use names", () => {
    const msgs: Message[] = [
      { id: "1", role: "assistant", content: [{ type: "tool_use", toolUseId: "t1", toolName: "bash", toolInput: {} }] },
      { id: "2", role: "assistant", content: [{ type: "tool_use", toolUseId: "t2", toolName: "mcp__pi__already", toolInput: {} }] },
      { id: "3", role: "assistant", content: [{ type: "tool_use", toolUseId: "t3", toolName: "not_allowed", toolInput: {} }] },
    ];
    const out = rewriteToolNamesForProjection(msgs, ["bash", "read"], "pi");
    expect(out[0].content[0].toolName).toBe("mcp__pi__bash");
    expect(out[1].content[0].toolName).toBe("mcp__pi__already"); // untouched
    expect(out[2].content[0].toolName).toBe("not_allowed"); // not in allowed set
  });

  test("claudeProjectKey matches Claude Code 2.1.197: every non-alnum → dash", () => {
    expect(claudeProjectKey("/home/dev/Projects/tiamat")).toBe("-home-dev-Projects-tiamat");
    expect(claudeProjectKey("/home/dev/.herdr/worktrees/x")).toBe("-home-dev--herdr-worktrees-x");
    expect(claudeProjectKey("/tmp/")).toBe("-tmp");
    expect(claudeProjectKey("")).toBe("-");
  });

  test("claudeModelArg adds [1m] only for 1M-context families", () => {
    expect(claudeModelArg("claude-opus-4-8")).toBe("claude-opus-4-8[1m]");
    expect(claudeModelArg("claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514[1m]");
    expect(claudeModelArg("claude-opus-4-8[1m]")).toBe("claude-opus-4-8[1m]"); // idempotent
    expect(claudeModelArg("claude-haiku-4-5")).toBe("claude-haiku-4-5"); // not a 1M family
    expect(claudeModelArg(undefined)).toBeUndefined();
    expect(claudeModelArg("claude_code")).toBe("claude_code");
  });
});
