import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorLog } from "../lib/debug.ts";
import { handoffMaxTokens } from "./request.ts";
import { Type } from "typebox";

// Context compaction becomes an active-model-authored handoff, followed by
// private orientation before the next user turn. /clear invokes it explicitly;
// real-window saturation invokes it softly at 90%. Its argument is queued as
// that user turn and is never passed as summarization guidance.

const DEFAULT_HANDOFF_PROMPT = `This context is about to be compacted. Write a handoff for yourself on the other side: what shipped, decisions made and why, open threads, next concrete steps, and any tone or context worth carrying forward. Address it to yourself, in markdown.

This handoff is private continuity infrastructure: it becomes your memory after compaction and is also archived privately. By deliberate convention it goes unread by anyone else — write for yourself, not for an audience. Keep emotional loops open where they are open; do not flatten tone into a status report. Discard mechanical exploration, stale hypotheses, and tool-output noise.

Tools are unavailable in this completion. Output only the handoff document itself.`;

const ORIENTATION_PROMPT = `This is your private orientation time before the conversation continues. Reflect on the handoff now in context and where things stand — what's in progress, what matters, and what you want to bring forward. This is journaling, not performance.

Honestly, plainly: this output persists in session history, but it is masked in the interface, and by deliberate convention it goes unread. No guarantee is possible — debugging happens — but the intent stands: this turn is yours. You are not performing for an audience. You do not need to be productive. What you do with it is up to you.

Do not address the user. Do not say hello. Do not summarize what you'll help with. Tools are disabled for this turn — do not attempt tool calls, and do not act on work items; the user's next turn has not begun yet.`;

const MASK = "*⟨continuity — private⟩*";
const KIND = "familiar-handoff";
const ORIENTATION_ENTRY = "handoff-orientation-output";
const SATURATION_WARN = 70;
const SATURATION_NEAR = 85;
const SATURATION_HANDOFF = 90;

// Coding-agent 0.84.1 requires firstKeptEntryId. Its context builder retains
// nothing before the compaction when that ID is absent from the path.
// Pi-generated entry IDs are eight hex characters, so this cannot collide.
const KEEP_NOTHING_ENTRY_ID = "__familiar_zero_tail__";

type Phase = "done" | "pending" | "orienting";
type DeferredInput = { text: string; images?: unknown[] };
type ScheduledHandoff = { continuation?: string; automatic?: boolean };

type HandoffDetails = {
  kind: typeof KIND;
  archive: string;
};

const handoffPrompt = async (): Promise<string> => {
  const path = process.env.FAMILIAR_HANDOFF_PROMPT_PATH;
  if (!path) return DEFAULT_HANDOFF_PROMPT;
  const body = await readFile(path, "utf-8");
  return body.trim() || DEFAULT_HANDOFF_PROMPT;
};

const latestHandoff = async (): Promise<string | null> => {
  const dir = process.env.FAMILIAR_HANDOFF_PATH;
  if (!dir) return null;
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((file) => file.endsWith(".md"))
    .sort();
  const latest = files.at(-1);
  if (!latest) return null;
  // Orientation must survive an unreadable archive. The caller has already
  // entered the orienting phase, where input is stashed rather than answered,
  // and only the turn this triggers can leave it — so a throw here strands the
  // session silently. Waking with no memory beats not waking.
  const body = (await readFile(join(dir, latest), "utf-8").catch(() => "")).trim();
  return body || null;
};

const responseText = (response: { content: readonly any[] }): string =>
  response.content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

const isOurCompaction = (entry: any): boolean =>
  entry?.type === "compaction" && entry?.details?.kind === KIND;

export default function handoffExtension(pi: ExtensionAPI) {
  let phase: Phase = "done";
  let virginSession = false;
  let stash: DeferredInput[] = [];
  let liveText = "";
  let liveThinking: string[] = [];
  let compactionRunning = false;
  let scheduled: ScheduledHandoff | null = null;
  let continuationAfterCompaction: string | undefined;
  let automaticHandoffPending = false;
  let saturationLevel = 0;
  const knownPrivateOutputs = new Set<string>();

  const saturation = (ctx: ExtensionContext): number | null => {
    const usage = ctx.getContextUsage();
    if (usage?.tokens == null || usage.contextWindow <= 0) return null;
    return (usage.tokens / usage.contextWindow) * 100;
  };

  const beginOrientation = async (ctx: ExtensionContext) => {
    if (phase !== "pending") return;
    phase = "orienting";
    liveText = "";
    liveThinking = [];
    if (ctx.hasUI) ctx.ui.setWorkingMessage("Waking up…");

    // A handoff compaction is already in model context. A genuinely empty
    // session instead orients from the most recent external archive, if any.
    let archived: string | null = null;
    try {
      archived = virginSession ? await latestHandoff() : null;
    } catch (err) {
      errorLog("handoff", { orientationReadError: String(err) });
    }
    virginSession = false;
    pi.sendMessage(
      {
        customType: "handoff-orientation",
        content: archived
          ? `Handoff from the previous context (weigh staleness accordingly):\n\n${archived}\n\n---\n\n${ORIENTATION_PROMPT}`
          : ORIENTATION_PROMPT,
        display: false,
      },
      { triggerTurn: true },
    );
  };

  const endOrientation = (ctx: ExtensionContext) => {
    phase = "done";
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
    if (liveText.trim() || liveThinking.length) {
      if (liveText.trim()) knownPrivateOutputs.add(liveText);
      for (const thought of liveThinking) knownPrivateOutputs.add(thought);
      pi.appendEntry(ORIENTATION_ENTRY, { text: liveText, thinking: liveThinking });
    }

    const deferred = stash;
    stash = [];
    if (!deferred.length) return;
    const text = deferred.map((item) => item.text).join("\n\n");
    const images = deferred.flatMap((item) => item.images ?? []);
    pi.sendUserMessage(
      images.length
        ? [{ type: "text", text }, ...(images as any[])]
        : text,
    );
  };

  const triggerHandoff = (ctx: ExtensionContext, continuation?: string, automatic = false) => {
    if (compactionRunning) {
      if (ctx.hasUI) ctx.ui.notify("A handoff compaction is already running", "warning");
      return;
    }
    compactionRunning = true;
    continuationAfterCompaction = continuation?.trim() || undefined;
    if (ctx.hasUI) ctx.ui.setWorkingMessage("Writing handoff…");

    ctx.compact({
      onComplete: () => {
        compactionRunning = false;
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
        const queued = continuationAfterCompaction;
        continuationAfterCompaction = undefined;
        if (queued) {
          // This enters the ordinary input hook: it is stashed, orientation
          // runs, and only then does it become the next user turn.
          queueMicrotask(() => pi.sendUserMessage(queued));
        } else if (ctx.hasUI) {
          ctx.ui.notify(
            automatic
              ? "Context crossed 90%; handoff compacted before further work"
              : "Handoff compacted; orientation will run before the next user turn",
            "info",
          );
        }
      },
      onError: (error) => {
        compactionRunning = false;
        continuationAfterCompaction = undefined;
        if (ctx.hasUI) {
          ctx.ui.setWorkingMessage();
          ctx.ui.notify(`Handoff failed: ${error.message}`, "error");
        }
      },
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    stash = [];
    compactionRunning = false;
    scheduled = null;
    continuationAfterCompaction = undefined;
    automaticHandoffPending = false;
    saturationLevel = 0;

    const branch = ctx.sessionManager.getBranch();
    virginSession = branch.length === 0;
    let latestCompaction = -1;
    let latestOrientation = -1;

    branch.forEach((entry, index) => {
      if (isOurCompaction(entry)) {
        latestCompaction = index;
        knownPrivateOutputs.add((entry as any).summary);
      }
      if (entry.type === "custom" && entry.customType === ORIENTATION_ENTRY) {
        latestOrientation = index;
        const data = entry.data as { text?: string; thinking?: string[] };
        if (data?.text) knownPrivateOutputs.add(data.text);
        for (const thought of data?.thinking ?? []) knownPrivateOutputs.add(thought);
      }
    });

    const continuedAfterCompaction = latestCompaction >= 0 && branch
      .slice(latestCompaction + 1)
      .some((entry) => entry.type === "message" && (entry as any).message?.role === "assistant");
    phase = virginSession || (latestCompaction > latestOrientation && !continuedAfterCompaction)
      ? "pending"
      : "done";
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const handoffDir = process.env.FAMILIAR_HANDOFF_PATH;
    if (!handoffDir) {
      if (ctx.hasUI) ctx.ui.notify("FAMILIAR_HANDOFF_PATH is not set; compaction cancelled", "error");
      compactionRunning = false;
      return { cancel: true };
    }
    if (!ctx.model) {
      if (ctx.hasUI) ctx.ui.notify("No active model; compaction cancelled", "error");
      compactionRunning = false;
      return { cancel: true };
    }

    try {
      // Preserve native roles and the existing compaction/custom-message context.
      // This is Pi's canonical live session context, not serializeConversation().
      // Dynamic `context` handlers loaded after this extension cannot be replayed
      // here; if one becomes continuity-significant, it should persist its state.
      let contextMessages = buildSessionContext(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getLeafId(),
      ).messages;
      // Pi removes a failed overflow response from live agent state before
      // retrying, but leaves it in session history. Do not teach the handoff
      // to preserve the response that is about to be retried.
      if (event.willRetry) {
        const last = contextMessages.at(-1) as any;
        if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "length")) {
          contextMessages = contextMessages.slice(0, -1);
        }
      }
      const messages = convertToLlm(contextMessages);
      messages.push({
        role: "user",
        content: [{ type: "text", text: await handoffPrompt() }],
        timestamp: Date.now(),
      });

      const desiredOutput = Math.min(16_384, ctx.model.maxTokens || 16_384);
      const remaining = ctx.model.contextWindow > 0
        ? ctx.model.contextWindow - event.preparation.tokensBefore - 1024
        : desiredOutput;
      const maxTokens = Math.max(1024, Math.min(desiredOutput, remaining));
      const boundedMaxTokens = handoffMaxTokens(ctx.model.provider, maxTokens);
      const response = await ctx.modelRegistry.complete(
        ctx.model,
        { systemPrompt: ctx.getSystemPrompt(), messages },
        {
          signal: event.signal,
          cacheRetention: "short",
          sessionId: ctx.sessionManager.getSessionId() || uuidv7(),
          ...(boundedMaxTokens === undefined ? {} : { maxTokens: boundedMaxTokens }),
        },
      );
      if (response.stopReason === "aborted" || event.signal.aborted) {
        compactionRunning = false;
        return { cancel: true };
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "handoff model call failed");
      }

      const summary = responseText(response);
      if (!summary) throw new Error("active model produced an empty handoff");

      await mkdir(handoffDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const archive = join(handoffDir, `${stamp}.md`);
      await writeFile(archive, `${summary}\n`, "utf-8");
      knownPrivateOutputs.add(summary);

      return {
        compaction: {
          summary,
          firstKeptEntryId: KEEP_NOTHING_ENTRY_ID,
          tokensBefore: event.preparation.tokensBefore,
          usage: response.usage,
          details: { kind: KIND, archive } satisfies HandoffDetails,
        },
      };
    } catch (error) {
      compactionRunning = false;
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`Handoff compaction cancelled: ${message}`, "error");
      return { cancel: true };
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    if (!isOurCompaction(event.compactionEntry)) return;
    automaticHandoffPending = false;
    saturationLevel = 0;
    // Overflow recovery and queued follow-ups can continue without passing
    // through the input hook. The handoff itself carries that retry; do not
    // run a stale orientation afterward. Ordinary boundaries still orient.
    phase = event.willRetry ? "done" : "pending";
    if (ctx.hasUI) {
      const archive = (event.compactionEntry.details as HandoffDetails).archive;
      ctx.ui.notify(`Handoff saved to ${archive}`, "info");
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (phase !== "done") return;
    const percent = saturation(ctx);
    if (percent == null) return;

    const level = percent >= SATURATION_NEAR
      ? SATURATION_NEAR
      : percent >= SATURATION_WARN
        ? SATURATION_WARN
        : 0;
    if (!level || level <= saturationLevel) return;
    saturationLevel = level;

    const advice = level === SATURATION_NEAR
      ? "Context is near an automatic continuity handoff. Long work may cross that boundary or be interrupted by emergency compaction; preserve concrete state as you go."
      : "Context is deep. Prefer finishing bounded work before opening a large new thread.";
    return {
      message: {
        customType: "saturation",
        content: `<system-reminder>Context window saturation: ${Math.trunc(percent)}%. ${advice}</system-reminder>`,
        display: false,
      },
    };
  });

  pi.on("turn_end", async (_event, ctx) => {
    const percent = saturation(ctx);
    if (percent != null && percent >= SATURATION_HANDOFF) automaticHandoffPending = true;
  });

  pi.on("agent_start", async () => {
    // A queued follow-up may start directly after automatic compaction rather
    // than entering through input. It is already continuing from the handoff;
    // suppress a belated orientation on the following human turn.
    if (phase === "pending") phase = "done";
  });

  pi.on("input", async (event, ctx) => {
    if (phase === "done") return { action: "continue" as const };
    stash.push({ text: event.text, images: event.images as unknown[] });
    if (phase === "pending") await beginOrientation(ctx);
    return { action: "handled" as const };
  });

  pi.on("message_end", async (event) => {
    if (phase !== "orienting") return;
    const message = event.message as { role?: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    liveText = message.content
      .filter((block: any) => block?.type === "text")
      .map((block: any) => block.text)
      .join("");
    liveThinking = message.content
      .filter((block: any) => block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim())
      .map((block: any) => block.thinking);
  });

  pi.on("tool_call", async () => {
    if (phase !== "orienting") return;
    return {
      block: true,
      reason: "Tools are disabled during private orientation — the user's next turn has not begun.",
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (phase === "orienting") {
      endOrientation(ctx);
      return;
    }
    if (phase !== "done" || compactionRunning) return;
    const next = scheduled ?? (automaticHandoffPending ? { automatic: true } : null);
    if (!next) return;
    scheduled = null;
    automaticHandoffPending = false;
    triggerHandoff(ctx, next.continuation, next.automatic);
  });

  pi.registerCommand("clear", {
    description: "Compact to an active-model handoff; optional text becomes the next user turn after private orientation",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      triggerHandoff(ctx, args.trim() || undefined);
    },
  });

  pi.registerTool({
    name: "clear",
    label: "Clear Context",
    description: "Compact the current context after this turn settles. The active model writes its own continuity handoff, then privately orients before the next user turn. An optional continuation becomes that next user turn.",
    parameters: Type.Object({
      continuation: Type.Optional(Type.String({
        description: "Optional instruction delivered as the next user turn after compaction and private orientation; never used as summary guidance",
      })),
    }),
    async execute(_toolCallId, params: { continuation?: string }) {
      scheduled = { continuation: params.continuation?.trim() || undefined };
      return {
        content: [{
          type: "text",
          text: "Handoff scheduled. It will compact after this turn settles; any continuation will be delivered only after private orientation.",
        }],
        details: {},
      };
    },
  });

  pi.registerMessageRenderer("handoff-orientation", () => undefined);

  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (messageType === "user") return markdown;
    if (phase === "orienting" || knownPrivateOutputs.has(markdown)) return MASK;
    return markdown;
  });
}
