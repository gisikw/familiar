import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { serviceCall } from "../lib/familiar-services.ts";
import { ImpIngress, IMP_BRANCH_HANDLER } from "./ingress.mjs";

const PENDING = "familiar.merge-pending.v1";
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

/** Owns Familiar's one private, per-resident Imp socket. Area implementations
 * are fixed process Symbols so load order is irrelevant and absent areas fail
 * explicitly without affecting the socket or another area. */
export default function (pi: ExtensionAPI) {
  let ingress: ImpIngress | undefined;
  let sending = false;

  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) process.env.FAMILIAR_SESSION_FILE = sessionFile;
    process.env.FAMILIAR_NODE ??= process.execPath;
    (process as any)[IMP_BRANCH_HANDLER] = {
      handle(request: { operation: string; args: { text?: unknown; quiet?: unknown } }) {
        if (request.operation !== "merge" || typeof request.args.text !== "string" || typeof request.args.quiet !== "boolean")
          throw Object.assign(new Error("invalid branch operation"), { code: "invalid_request" });
        pi.appendEntry(PENDING, { summary: request.args.text, quiet: request.args.quiet });
        return { queued: true };
      },
    };
    // A fork that crashed after queueing its merge restarts idle; no turn will
    // settle on its own, so flush the pending return once startup finishes.
    setTimeout(() => { if (ctx.isIdle()) void flush(ctx).catch(() => {}); }, 0);
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

  pi.on("agent_settled", async (_event, ctx) => flush(ctx));

  async function flush(ctx: any) {
    if (sending) return;
    const entries = ctx.sessionManager.getBranch() as Entry[];
    const pendingIndex = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === PENDING);
    const sentIndex = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === SENT);
    if (pendingIndex < 0 || pendingIndex < sentIndex) return;

    const pending = entries[pendingIndex].data;
    if (typeof pending?.summary !== "string" || typeof pending?.quiet !== "boolean") return;
    const forkIndex = entries.findLastIndex((entry, index) => index < pendingIndex && entry.type === "custom" && entry.customType === "familiar.fork.v1");
    const fork = forkIndex < 0 ? undefined : entries[forkIndex].data;
    const sessionId = process.env.FAMILIAR_INSTANCE_ID;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const leaf = entries.at(-1)?.id;
    if (!fork?.parentSessionId || !fork?.branchEntryId || !sessionId || !sessionFile || !leaf) return;

    const finalAssistant = entries.slice(pendingIndex + 1).findLast((entry) => entry.type === "message" && entry.message?.role === "assistant");
    const lastWords = textContent(finalAssistant?.message?.content);
    const summary = lastWords ? `${pending.summary}\n\nlast words:\n${lastWords}` : pending.summary;
    const body = {
      summary,
      forkSessionId: sessionId,
      forkSessionFile: sessionFile,
      branchEntryId: fork.branchEntryId,
      firstEntryId: entries[forkIndex]?.id,
      lastEntryId: leaf,
      turnCount: entries.slice(forkIndex).filter((entry) => entry.type === "message").length,
      forkedFurther: forkedFurther(process.env.FAMILIAR_STATE_DIR, sessionId),
      mergedAt: new Date().toISOString(),
    };
    const request: Record<string, unknown> = {
      id: `merge-${sessionId}-${leaf}`,
      target: `instance:${fork.parentSessionId}`,
      origin: sessionId,
      type: "merge",
      source: "imp.merge",
      summary,
      body: JSON.stringify(body),
    };
    if (pending.quiet) request.urgency = "soft";

    sending = true;
    try {
      await serviceCall("schedule.enqueue", request);
      pi.appendEntry(SENT, { summary, quiet: pending.quiet, lastEntryId: leaf });
      ctx.shutdown();
    } finally {
      sending = false;
    }
  }

  pi.on("session_shutdown", async () => {
    const old = ingress;
    ingress = undefined;
    if ((process as any)[IMP_BRANCH_HANDLER]) delete (process as any)[IMP_BRANCH_HANDLER];
    delete process.env.FAMILIAR_SESSION_FILE;
    await old?.stop();
  });
}
