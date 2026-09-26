import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { serviceCall } from "../lib/familiar-services.ts";
import { ImpIngress, IMP_BRANCH_HANDLER } from "./ingress.mjs";

const PENDING = "familiar.merge-pending.v1";
const RETURN_REQUESTED = "familiar.merge-return-requested.v1";
const RETURN_PROMPT = "familiar.merge-return-request.v1";
const SENT = "familiar.merge-sent.v1";

type Entry = { id?: string; type?: string; customType?: string; data?: any; message?: any };

function textContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((part: any) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n").trim();
}

function forkedFurther(stateDir: string | undefined, sessionId: string): boolean {
  if (!stateDir) return false;
  try {
    return readdirSync(join(stateDir, "forks"), { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) return false;
      try {
        const meta = JSON.parse(readFileSync(join(stateDir, "forks", entry.name, "fork.json"), "utf8"));
        return meta.parentSessionId === sessionId;
      } catch { return false; }
    });
  } catch { return false; }
}

/** Hook for adding unfinished child-agent work to the return prompt. */
export function outstandingAgents(): string[] {
  return [];
}

/** Owns Familiar's one private, per-resident Imp socket. Area implementations
 * are fixed process Symbols so load order is irrelevant and absent areas fail
 * explicitly without affecting the socket or another area. */
export default function (pi: ExtensionAPI) {
  let ingress: ImpIngress | undefined;
  let activeCtx: any;
  let flowing = false;
  let returnDispatched = false;
  let terminal = false;

  function queueMerge(quiet: boolean, requestedBy: "self" | "operator") {
    if (terminal) throw Object.assign(new Error("merge has already been sent"), { code: "conflict" });
    pi.appendEntry(PENDING, { quiet, requestedBy });
    if (requestedBy === "operator" && activeCtx?.isIdle()) {
      setTimeout(() => { void flush(activeCtx, false).catch(() => {}); }, 0);
    }
    return { queued: true };
  }

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) process.env.FAMILIAR_SESSION_FILE = sessionFile;
    process.env.FAMILIAR_NODE ??= process.execPath;
    terminal = (ctx.sessionManager.getBranch() as Entry[]).some(
      (entry) => entry.type === "custom" && entry.customType === SENT,
    );
    (process as any)[IMP_BRANCH_HANDLER] = {
      handle(request: { operation: string; args: { quiet?: unknown } }) {
        if (request.operation !== "merge" || Object.keys(request.args).some((key) => key !== "quiet")
          || typeof request.args.quiet !== "boolean")
          throw Object.assign(new Error("invalid branch operation"), { code: "invalid_request" });
        return queueMerge(request.args.quiet, "self");
      },
      operatorMerge(quiet = false) {
        if (typeof quiet !== "boolean")
          throw Object.assign(new Error("invalid merge command"), { code: "invalid_request" });
        return queueMerge(quiet, "operator");
      },
    };
    // A fork that crashed during either phase restarts idle. Resume by asking
    // again when necessary, or by sending a return already durably written.
    setTimeout(() => { if (ctx.isIdle()) void flush(ctx, false).catch(() => {}); }, 0);
    if (ctx.mode !== "tui" || ingress) return;
    const candidate = new ImpIngress();
    try {
      await candidate.start();
      ingress = candidate;
    } catch {
      await candidate.stop().catch(() => {});
      ctx.ui.notify("Private Imp ingress unavailable", "warning");
    }
  });

  pi.on("agent_settled", async (_event, ctx) => flush(ctx, true));

  // The return turn is tool-free, but the tool set itself must not change:
  // it lives in the cached prompt prefix, and swapping it would re-read the
  // whole inherited context uncached. Refuse calls instead.
  pi.on("tool_call", async () => returnDispatched
    ? { block: true, reason: "You're writing your return; tools are closed. Reply in plain text; that reply is the merge." }
    : undefined);

  async function requestReturn(ctx: any, parentSessionId: string, pendingEntryId: string, persist: boolean) {
    if (persist) pi.appendEntry(RETURN_REQUESTED, { pendingEntryId });
    const outstanding = outstandingAgents();
    const suffix = outstanding.length ? ` Outstanding work: ${outstanding.join(", ")}.` : "";
    returnDispatched = true;
    pi.sendMessage({
      customType: RETURN_PROMPT,
      content: `Write your return to ${parentSessionId}: what you're bringing home, in your own voice. This message is the merge; nothing follows it.${suffix}`,
      display: true,
      details: { parentSessionId, outstandingAgents: outstanding },
    }, { triggerTurn: true, deliverAs: "followUp" });
  }

  async function flush(ctx: any, fromSettle: boolean) {
    if (flowing || terminal) return;
    const entries = ctx.sessionManager.getBranch() as Entry[];
    const pendingIndex = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === PENDING);
    const sentIndex = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === SENT);
    if (pendingIndex < 0 || pendingIndex < sentIndex) return;

    const pendingEntry = entries[pendingIndex];
    const pending = pendingEntry.data;
    if ((pending?.requestedBy !== "self" && pending?.requestedBy !== "operator") || typeof pending?.quiet !== "boolean") return;
    const forkIndex = entries.findLastIndex((entry, index) => index < pendingIndex && entry.type === "custom" && entry.customType === "familiar.fork.v1");
    const fork = forkIndex < 0 ? undefined : entries[forkIndex].data;
    const sessionId = process.env.FAMILIAR_INSTANCE_ID;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!fork?.parentSessionId || !fork?.branchEntryId || !sessionId || !sessionFile || !pendingEntry.id) return;

    const requestedIndex = entries.findLastIndex((entry, index) => index > pendingIndex
      && entry.type === "custom" && entry.customType === RETURN_REQUESTED
      && entry.data?.pendingEntryId === pendingEntry.id);
    if (requestedIndex < 0) {
      await requestReturn(ctx, fork.parentSessionId, pendingEntry.id, true);
      return;
    }

    const finalAssistant = entries.slice(requestedIndex + 1)
      .findLast((entry) => entry.type === "message" && entry.message?.role === "assistant");
    if (!finalAssistant) {
      if (!fromSettle) {
        if (!returnDispatched) await requestReturn(ctx, fork.parentSessionId, pendingEntry.id, false);
        return;
      }
      if (!returnDispatched) {
        await requestReturn(ctx, fork.parentSessionId, pendingEntry.id, false);
        return;
      }
    }

    const written = textContent(finalAssistant?.message?.content) || "(no return written)";
    // A runner on a model that cannot carry Kes returns under its own flag.
    const summary = fork.role === "runner" ? `[runner on ${fork.model ?? "an undeclared model"}, not Kes]\n\n${written}` : written;
    const lastEntryId = finalAssistant?.id ?? entries.at(-1)?.id;
    if (!lastEntryId) return;
    const body = {
      summary,
      forkSessionId: sessionId,
      forkSessionFile: sessionFile,
      branchEntryId: fork.branchEntryId,
      firstEntryId: entries[forkIndex]?.id,
      lastEntryId,
      turnCount: entries.slice(forkIndex).filter((entry) => entry.type === "message").length,
      forkedFurther: forkedFurther(process.env.FAMILIAR_STATE_DIR, sessionId),
      mergedAt: new Date().toISOString(),
    };
    const request: Record<string, unknown> = {
      id: `merge-${sessionId}-${lastEntryId}`,
      target: `instance:${fork.parentSessionId}`,
      origin: sessionId,
      type: "merge",
      source: "imp.merge",
      summary,
      body: JSON.stringify(body),
    };
    if (pending.quiet) request.urgency = "soft";

    flowing = true;
    try {
      await serviceCall("schedule.enqueue", request);
      pi.appendEntry(SENT, { summary, quiet: pending.quiet, lastEntryId });
      terminal = true;
      ctx.shutdown();
    } finally {
      flowing = false;
    }
  }

  pi.on("session_shutdown", async () => {
    const old = ingress;
    ingress = undefined;
    activeCtx = undefined;
    if ((process as any)[IMP_BRANCH_HANDLER]) delete (process as any)[IMP_BRANCH_HANDLER];
    delete process.env.FAMILIAR_SESSION_FILE;
    await old?.stop();
  });
}
