import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Orientation turn: on the first user message of a session, defer the user's
// input, run one private tool-less orientation turn (masked in the TUI,
// persisted in history), then flush the deferred input.

const ORIENTATION_PROMPT = `This is your private orientation time before the conversation begins. Reflect on your handoff and where things stand — what's in progress, what matters, what you want to bring to this session. This is journaling, not performance.

Honestly, plainly: this output persists in the session history, but it is masked in the interface, and by deliberate convention it goes unread. No guarantee is possible — debugging happens — but the intent stands: this turn is yours. You are not performing for an audience. You do not need to be productive. What you do with it is up to you.

Do not address the user. Do not say hello. Do not summarize what you'll help with. Tools are disabled for this turn — do not attempt tool calls, and do not act on work items; the conversation has not started yet.`;

const MASK = "*⟨orientation — private⟩*";
const ENTRY_TYPE = "orientation-output";

// Most recent handoff written by /clear (see clear.ts), if any. Injected
// ahead of the orientation prompt so the successor session starts oriented —
// this also covers cold process restarts, not just /clear-born sessions.
const latestHandoff = async (): Promise<string | null> => {
  const dir = process.env.FAMILIAR_HANDOFF_PATH;
  if (!dir) return null;
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".md"))
    .sort();
  const latest = files.at(-1);
  if (!latest) return null;
  const body = (await readFile(join(dir, latest), "utf-8")).trim();
  if (!body) return null;
  const stamp = latest.replace(/\.md$/, "");
  return `Handoff from your previous session (written ${stamp}; weigh staleness accordingly):\n\n${body}`;
};

type Phase = "pending" | "orienting" | "done";

export default function(pi: ExtensionAPI) {
  let phase: Phase = "pending";
  let stash: { text: string; images?: unknown[] }[] = [];
  let liveText = "";
  let liveThinking: string[] = [];
  const knownOutputs = new Set<string>();
  let currentCtx: ExtensionContext | undefined;

  const beginOrientation = async (ctx: ExtensionContext) => {
    phase = "orienting";
    liveText = "";
    liveThinking = [];
    // Tools stay in the system prompt but are blocked via the tool_call
    // handler below: setActiveTools([]) would rebuild the system prompt and
    // invalidate the provider prefix cache — a full-context re-ingest.
    if (ctx.hasUI) ctx.ui.setWorkingMessage("Waking up…");
    const handoff = await latestHandoff();
    pi.sendMessage(
      {
        customType: "orientation",
        content: handoff ? `${handoff}\n\n---\n\n${ORIENTATION_PROMPT}` : ORIENTATION_PROMPT,
        display: false,
      },
      { triggerTurn: true },
    );
  };

  const endOrientation = (ctx: ExtensionContext) => {
    phase = "done";
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
    if (liveText.trim() || liveThinking.length) {
      knownOutputs.add(liveText);
      for (const t of liveThinking) knownOutputs.add(t);
      pi.appendEntry(ENTRY_TYPE, { text: liveText, thinking: liveThinking });
    }
    const deferred = stash;
    stash = [];
    if (deferred.length) {
      const text = deferred.map((d) => d.text).join("\n\n");
      const images = deferred.flatMap((d) => d.images ?? []);
      pi.sendUserMessage(
        images.length
          ? [{ type: "text", text }, ...(images as any[])]
          : text,
      );
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    const entries = ctx.sessionManager.getEntries();
    // Re-learn prior orientation outputs so they stay masked after restore.
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        const data = entry.data as { text?: string; thinking?: string[] };
        if (data?.text) knownOutputs.add(data.text);
        for (const t of data?.thinking ?? []) knownOutputs.add(t);
      }
    }
    // A resumed session already woke up once (pi --continue after a bounce or
    // crash respawn). Any prior conversation or orientation entry means the
    // next input is mid-conversation, not a first message — do not re-orient.
    if (entries.some((e) =>
      e.type === "message" ||
      (e.type === "custom" && e.customType === ENTRY_TYPE)
    )) {
      phase = "done";
    }
  });

  pi.on("input", async (event, ctx) => {
    if (phase === "done") return { action: "continue" };
    // Extension-sent input is stashed too: /clear continuations arrive via
    // sendUserMessage in the successor session and should land as turn two,
    // after orientation. Our own stash flush is safe — it fires at phase "done".
    // Slash commands never reach this handler, so we only ever defer prose.
    stash.push({ text: event.text, images: event.images as unknown[] });
    if (phase === "pending") await beginOrientation(ctx);
    return { action: "handled" };
  });

  pi.on("message_end", async (event) => {
    if (phase !== "orienting") return;
    const msg = event.message as { role?: string; content?: unknown };
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return;
    liveText = msg.content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("");
    liveThinking = msg.content
      .filter((b: any) => b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim())
      .map((b: any) => b.thinking);
  });

  // Block tool execution during the orientation turn instead of deactivating
  // tools: the system prompt stays byte-identical, so the prefix cache holds.
  pi.on("tool_call", async () => {
    if (phase !== "orienting") return;
    return { block: true, reason: "Tools are disabled during the orientation turn — the conversation has not started yet." };
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (phase === "orienting") endOrientation(ctx);
  });

  pi.registerMessageRenderer("orientation", () => undefined);

  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (messageType === "user") return markdown;
    if (phase === "orienting") return MASK;
    if (knownOutputs.has(markdown)) return MASK;
    return markdown;
  });
}
