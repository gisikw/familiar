import { expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const piRoot = process.env.PI_PACKAGE_DIR;
if (!piRoot) throw new Error("PI_PACKAGE_DIR is required (point it at Familiar's pinned Pi package)");
const realCodingAgent = await import(join(piRoot, "dist/index.js"));
const realPiAi = await import(join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"));
const realPiTui = await import(join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"));
const realTypebox = await import(join(piRoot, "node_modules/typebox/build/index.mjs"));
mock.module("@earendil-works/pi-coding-agent", () => realCodingAgent);
mock.module("@earendil-works/pi-ai", () => realPiAi);
mock.module("@earendil-works/pi-tui", () => realPiTui);
mock.module("typebox", () => realTypebox);
const { default: zipExtension } = await import("./index.ts");

/*
 * /rewind is tree-style: the abandoned turns become an inactive branch in the
 * same session file. Nothing on disk is deleted or rewritten. This drives the
 * real /rewind handler through Pi's own AgentSession.navigateTree against a
 * real on-disk SessionManager, then continues on the new branch and re-reads
 * the file.
 */

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;
const user = (id: string, parentId: string | null, text: string, n: number) => ({ type: "message", id, parentId, timestamp: at(n), message: { role: "user", content: [{ type: "text", text }], timestamp: n } });
const reply = (id: string, parentId: string, text: string, n: number) => ({
  type: "message",
  id,
  parentId,
  timestamp: at(n),
  message: { role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic", model: "test", usage, stopReason: "stop", timestamp: n },
});

const harness = async (root: string) => {
  const { SessionManager } = await import(`${piRoot}/dist/core/session-manager.js`);
  const { AgentSession } = await import(`${piRoot}/dist/core/agent-session.js`);
  const file = join(root, "session.jsonl");
  const lines = [
    { type: "session", version: 3, id: "s", timestamp: at(0), cwd: root },
    user("u1", null, "hello", 1),
    reply("a1", "u1", "hi", 2),
    user("u2", "a1", "classifier bait", 3),
    reply("a2", "u2", "oops", 4),
  ];
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const before = readFileSync(file, "utf8");
  const manager = SessionManager.open(file, root);

  // Just enough of an AgentSession for Pi's real navigateTree (no summary path).
  const session = Object.create(AgentSession.prototype);
  const own = {
    sessionManager: manager,
    _extensionRunner: { hasHandlers: () => false, emit: async () => undefined },
    agent: { state: { messages: [] } },
    model: undefined,
    isStreaming: false,
  };
  // Some of these are prototype getters; shadow them as own properties.
  for (const [key, value] of Object.entries(own)) Object.defineProperty(session, key, { value, writable: true, configurable: true });

  const commands = new Map<string, any>();
  const pi = new Proxy({} as any, {
    get: (_t, key) => (key === "registerCommand" ? (name: string, spec: any) => commands.set(name, spec) : () => undefined),
  });
  zipExtension(pi);

  let editor = "";
  const notes: string[] = [];
  const ctx = {
    hasUI: true,
    sessionManager: manager,
    waitForIdle: async () => undefined,
    navigateTree: async (id: string, options: any) => {
      const result = await session.navigateTree(id, options);
      if (result.editorText && !editor.trim()) editor = result.editorText; // what interactive mode does
      return { cancelled: result.cancelled };
    },
    ui: { notify: (message: string) => notes.push(message), getEditorText: () => editor, setEditorText: (text: string) => (editor = text) },
  };
  return { file, before, manager, rewind: (args: string) => commands.get("rewind").handler(args, ctx), notes, editor: () => editor, SessionManager };
};

/** The conversation the model would see from this manager, as message ids. */
const path = (manager: any) => manager.getBranch().filter((entry: any) => entry.type === "message").map((entry: any) => entry.id);

test("rewinding to a user message leaves every old entry on disk as an inactive branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "familiar-rewind-"));
  try {
    const h = await harness(root);
    await h.rewind("u2");
    // Active path is back at u2's parent; the TUI's copy of the text was cleared (the browser restores its own).
    expect(path(h.manager)).toEqual(["u1", "a1"]);
    expect(h.editor()).toBe("");
    expect(h.notes.at(-1)).toContain("2 entries moved to an inactive branch");
    // Append-only: the old bytes are untouched; Pi only added a label entry.
    expect(readFileSync(h.file, "utf8").startsWith(h.before)).toBe(true);
    // A restart before the next message still lands on the rewound branch.
    expect(path(h.SessionManager.open(h.file, root))).toEqual(["u1", "a1"]);

    // Continue on the new branch, then re-read the file from disk.
    h.manager.appendMessage({ role: "user", content: [{ type: "text", text: "reworded" }], timestamp: 5 });
    expect(readFileSync(h.file, "utf8").startsWith(h.before)).toBe(true);
    const reopened = h.SessionManager.open(h.file, root);
    const ids = reopened.getEntries().map((entry: any) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(["u1", "a1", "u2", "a2"]));
    const active = path(reopened);
    expect(active.slice(0, 2)).toEqual(["u1", "a1"]);
    expect(active).toHaveLength(3);
    expect(active).not.toContain("u2");
    expect(active).not.toContain("a2");
    // u2 and a2 are still a branch hanging off a1, beside the new message.
    const byId = new Map(reopened.getEntries().map((entry: any) => [entry.id, entry]));
    expect((byId.get("u2") as any).parentId).toBe("a1");
    expect((byId.get("a2") as any).parentId).toBe("u2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rewinding to a reply keeps it; refusals move nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "familiar-rewind-"));
  try {
    const h = await harness(root);
    await h.rewind("a2");
    expect(path(h.manager)).toEqual(["u1", "a1", "u2", "a2"]); // already the leaf: refused
    expect(h.notes.at(-1)).toContain("nothing to set aside");
    await h.rewind("nope");
    expect(readFileSync(h.file, "utf8")).toBe(h.before); // refusals write nothing
    await h.rewind("#a1");
    expect(path(h.manager)).toEqual(["u1", "a1"]);
    expect(readFileSync(h.file, "utf8").startsWith(h.before)).toBe(true);
    expect(path(h.SessionManager.open(h.file, root))).toEqual(["u1", "a1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
