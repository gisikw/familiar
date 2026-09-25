import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function expectStrictPrefix(prefix: unknown[], whole: unknown[]) {
  expect(prefix.length).toBeLessThan(whole.length);
  expect(whole.slice(0, prefix.length)).toEqual(prefix);
}

test("fork provider messages retain the parent and previous-turn prefixes", async () => {
  const root = mkdtempSync(join(tmpdir(), "familiar-fork-prefix-"));
  try {
    const piRoot = process.env.PI_PACKAGE_DIR!;
    const { SessionManager } = await import(`${piRoot}/dist/core/session-manager.js`);
    const { convertToLlm } = await import(`${piRoot}/dist/core/messages.js`);
    const parent = join(root, "parent.jsonl");
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const prefix = [
      { type: "session", version: 3, id: "parent-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
      { type: "message", id: "user0001", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "Please delegate this.", timestamp: 1 } },
      { type: "message", id: "branch01", parentId: "user0001", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-fork", name: "bash", arguments: { command: "imp fork \"inspect cache\"" } }, { type: "toolCall", id: "call-other", name: "read", arguments: { path: "later" } }], api: "anthropic-messages", provider: "anthropic", model: "test", usage, stopReason: "toolUse", timestamp: 2 } },
      // Labels live outside the selected path, but Pi copies resolved labels to
      // the end of a branched session and makes the last one its leaf.
      { type: "label", id: "label001", parentId: "branch01", timestamp: "2026-01-01T00:00:03.000Z", targetId: "user0001", label: "request" },
      { type: "label", id: "label002", parentId: "label001", timestamp: "2026-01-01T00:00:04.000Z", targetId: "branch01", label: "fork point" },
    ];
    writeFileSync(parent, prefix.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const parentManager = SessionManager.open(parent, root);
    const parentMessages = convertToLlm(parentManager.buildSessionContext().messages);

    const sessions = join(root, "sessions");
    mkdirSync(sessions);
    const helper = resolve(import.meta.dir, "../../../../scripts/fork-session.mjs");
    const run = spawnSync(process.execPath, [helper, piRoot, parent, "branch01", sessions, "parent-session"], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const made = JSON.parse(run.stdout);
    const fork = SessionManager.open(made.file, sessions);
    const forkPath = fork.getBranch();
    const markerIndex = forkPath.findIndex((entry: any) => entry.type === "custom" && entry.customType === "familiar.fork.v1");
    const resultIndexes = forkPath.flatMap((entry: any, index: number) => entry.type === "message" && entry.message.role === "toolResult" ? [index] : []);
    expect(forkPath.slice(1).every((entry: any, index: number) => entry.parentId === forkPath[index].id)).toBe(true);
    expect(forkPath.slice(2, 4).map((entry: any) => entry.type)).toEqual(["label", "label"]);
    expect(resultIndexes).toHaveLength(2);
    expect(Math.max(...resultIndexes)).toBeLessThan(markerIndex);

    // Pi's initial-message path persists this user message before constructing
    // the provider request. Build both requests from the session, as Pi does.
    const task = "Inspect cache behavior.\n";
    fork.appendMessage({ role: "user", content: task, timestamp: 3 });
    const turn1 = convertToLlm(fork.buildSessionContext().messages);
    fork.appendMessage({ role: "assistant", content: [{ type: "text", text: "Working." }], api: "anthropic-messages", provider: "anthropic", model: "test", usage, stopReason: "stop", timestamp: 4 });
    fork.appendMessage({ role: "user", content: "Continue.", timestamp: 5 });
    const turn2 = convertToLlm(fork.buildSessionContext().messages);

    expectStrictPrefix(parentMessages, turn1);
    expectStrictPrefix(turn1, turn2);
    expect(turn1[2]).toMatchObject({ role: "toolResult", toolCallId: "call-fork", toolName: "bash", content: [{ type: "text", text: expect.stringContaining(`fork ${made.id} of parent-session`) }] });
    expect(turn1[3]).toMatchObject({ role: "toolResult", toolCallId: "call-other", content: [{ type: "text", text: "Not run in this fork." }] });
    const resultIds = new Set(turn1.filter((message: any) => message.role === "toolResult").map((message: any) => message.toolCallId));
    const dangling = turn1.flatMap((message: any) => message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((block: any) => block.type === "toolCall" && !resultIds.has(block.id))
      : []);
    expect(dangling).toEqual([]);
    expect(turn1.at(-1)).toMatchObject({ role: "user", content: task });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
