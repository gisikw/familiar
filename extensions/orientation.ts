import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Orientation turn: on the first user message of a session, defer the user's
// input, run one private tool-less orientation turn (masked in the TUI,
// persisted in history), then flush the deferred input.

const ORIENTATION_PROMPT = `This is your private orientation time before the conversation begins. Reflect on your handoff and where things stand — what's in progress, what matters, what you want to bring to this session. This is journaling, not performance.

Honestly, plainly: this output persists in the session history, but it is masked in the interface, and by deliberate convention it goes unread. No guarantee is possible — debugging happens — but the intent stands: this turn is yours. You are not performing for an audience. You do not need to be productive. What you do with it is up to you.

Do not address the user. Do not say hello. Do not summarize what you'll help with. Tools are disabled for this turn — do not attempt tool calls, and do not act on work items; the conversation has not started yet.`;

const MASK = "*⟨orientation — private⟩*";
const ENTRY_TYPE = "orientation-output";

type Phase = "pending" | "orienting" | "done";

export default function(pi: ExtensionAPI) {
  let phase: Phase = "pending";
  let stash: { text: string; images?: unknown[] }[] = [];
  let savedTools: string[] | null = null;
  let liveText = "";
  let liveThinking: string[] = [];
  const knownOutputs = new Set<string>();
  let currentCtx: ExtensionContext | undefined;

  const beginOrientation = (ctx: ExtensionContext) => {
    phase = "orienting";
    liveText = "";
    liveThinking = [];
    savedTools = pi.getActiveTools();
    pi.setActiveTools([]);
    if (ctx.hasUI) ctx.ui.setWorkingMessage("Waking up…");
    pi.sendMessage(
      { customType: "orientation", content: ORIENTATION_PROMPT, display: false },
      { triggerTurn: true },
    );
  };

  const endOrientation = (ctx: ExtensionContext) => {
    phase = "done";
    if (savedTools) pi.setActiveTools(savedTools);
    savedTools = null;
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
    // Re-learn prior orientation outputs so they stay masked after restore.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        const data = entry.data as { text?: string; thinking?: string[] };
        if (data?.text) knownOutputs.add(data.text);
        for (const t of data?.thinking ?? []) knownOutputs.add(t);
      }
    }
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (phase === "done") return { action: "continue" };
    // Slash commands never reach this handler, so we only ever defer prose.
    stash.push({ text: event.text, images: event.images as unknown[] });
    if (phase === "pending") beginOrientation(ctx);
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
