import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
const execFileP = promisify(execFile);

// /clear [continuation]: end the session with a handoff. Runs one final
// tool-less handoff turn in the dying session (prompt hidden, output masked —
// the handoff is written for the successor, not for an audience), writes it
// to $FAMILIAR_HANDOFF_PATH/<timestamp>.md, then replaces the session. Any
// continuation text is sent into the successor session, where orientation
// stashes it: orientation runs first, continuation becomes turn two.
// The read side lives in orientation.ts.
//
// The `clear` tool queues the command as a follow-up user message, because
// session control only exists on command contexts (deadlocks elsewhere).
// Free property: a model-initiated clear always finishes the current turn
// before the handoff runs.
//
// The handoff prompt can be overridden via $FAMILIAR_HANDOFF_PROMPT_PATH
// (plain file, or .age decrypted with $FAMILIAR_AGE_KEY) — this repo is
// public; a personal prompt belongs outside it.

const DEFAULT_HANDOFF_PROMPT = `This session is ending. Write a handoff for the session that comes after you: what shipped, decisions made and why, open threads, next concrete steps, and any tone or context worth carrying forward. Address it to your successor, in markdown.

This handoff is private continuity infrastructure: masked in the interface, saved outside the repo, injected into your successor's orientation. By deliberate convention it goes unread by anyone else — write for your successor, not for an audience. Keep emotional loops open where they are open; do not flatten tone into a status report.

Tools are disabled for this turn — write from what you already hold. Output only the handoff document itself.`;

const MASK = "*⟨handoff — private⟩*";
const ENTRY_TYPE = "handoff-output";

const handoffPrompt = async (): Promise<string> => {
  const path = process.env.FAMILIAR_HANDOFF_PROMPT_PATH;
  if (!path) return DEFAULT_HANDOFF_PROMPT;
  const body = extname(path) === ".age"
    ? (await execFileP("age", ["-i", process.env.FAMILIAR_AGE_KEY!, "--decrypt", path])).stdout
    : await readFile(path, "utf-8");
  return body.trim() || DEFAULT_HANDOFF_PROMPT;
};

export default function(pi: ExtensionAPI) {
  let phase: "idle" | "handoff" = "idle";
  let captured: string[] = [];
  let capturedThinking: string[] = [];
  let settled: (() => void) | null = null;
  const knownOutputs = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    // Re-learn prior handoff outputs so they stay masked after restore.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        const data = entry.data as { text?: string; thinking?: string[] };
        if (data?.text) knownOutputs.add(data.text);
        for (const t of data?.thinking ?? []) knownOutputs.add(t);
      }
    }
  });

  pi.on("message_end", async (event) => {
    if (phase !== "handoff") return;
    const msg = event.message as { role?: string; content?: unknown };
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return;
    const text = msg.content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("");
    if (text.trim()) captured.push(text);
    capturedThinking.push(
      ...msg.content
        .filter((b: any) => b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim())
        .map((b: any) => b.thinking),
    );
  });

  pi.on("agent_settled", async () => {
    if (settled) { const resolve = settled; settled = null; resolve(); }
  });

  pi.registerCommand("clear", {
    description: "Write a handoff, then start a fresh session; optional text becomes the successor's first message (after orientation)",
    handler: async (args, ctx) => {
      if (phase === "handoff") return;
      const continuation = (args ?? "").trim();
      const handoffDir = process.env.FAMILIAR_HANDOFF_PATH;
      if (!handoffDir) {
        ctx.ui.notify("FAMILIAR_HANDOFF_PATH is not set", "error");
        return;
      }

      await ctx.waitForIdle();
      phase = "handoff";
      captured = [];
      capturedThinking = [];
      const savedTools = pi.getActiveTools();
      pi.setActiveTools([]);
      if (ctx.hasUI) ctx.ui.setWorkingMessage("Writing handoff…");
      try {
        const turnDone = new Promise<void>((resolve) => { settled = resolve; });
        pi.sendMessage(
          { customType: "handoff-request", content: await handoffPrompt(), display: false },
          { triggerTurn: true },
        );
        await turnDone;
      } finally {
        phase = "idle";
        settled = null;
        pi.setActiveTools(savedTools);
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
      }

      const handoff = captured.join("\n\n").trim();
      if (captured.length || capturedThinking.length) {
        for (const t of captured) knownOutputs.add(t);
        for (const t of capturedThinking) knownOutputs.add(t);
        pi.appendEntry(ENTRY_TYPE, { text: handoff, thinking: capturedThinking });
      }
      if (!handoff) {
        ctx.ui.notify("No handoff produced; staying in this session", "warning");
        return;
      }

      await mkdir(handoffDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = join(handoffDir, `${stamp}.md`);
      await writeFile(file, handoff + "\n", "utf-8");

      const parentSession = ctx.sessionManager.getSessionFile();
      await ctx.newSession({
        parentSession,
        withSession: async (ctx) => {
          if (ctx.hasUI) ctx.ui.notify(`Fresh session — handoff saved to ${file}`, "info");
          if (continuation) await ctx.sendUserMessage(continuation);
        },
      });
    },
  });

  pi.registerTool({
    name: "clear",
    label: "Clear Context",
    description:
      "End this session: write a handoff and start a fresh one. Runs after the current turn completes. Optionally pass a continuation — it is delivered to the successor session as its first message, after orientation.",
    parameters: Type.Object({
      continuation: Type.Optional(Type.String({
        description: "Instruction for the successor session, delivered as its first user message after orientation",
      })),
    }),
    async execute(_toolCallId, params: { continuation?: string }) {
      const continuation = params.continuation?.trim();
      pi.sendUserMessage(continuation ? `/clear ${continuation}` : "/clear", { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "Queued /clear — the handoff turn will run when this turn completes." }],
      };
    },
  });

  pi.registerMessageRenderer("handoff-request", () => undefined);

  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (messageType === "user") return markdown;
    if (phase === "handoff") return MASK;
    if (knownOutputs.has(markdown)) return MASK;
    return markdown;
  });
}
