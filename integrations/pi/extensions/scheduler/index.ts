import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorLog } from "../lib/debug.ts";
import { SchedulerClient, type ScheduledEvent } from "./client.ts";

const execFileAsync = promisify(execFile);
export const SCHEDULED_FORK = "familiar.scheduled-fork.v1";

/** The Pi is only a scheduler transport endpoint: connect, inject, acknowledge.
 * The one exception is a `fork` event: it spawns a background fork of this
 * instance and takes no model turn here. */
export default function (pi: ExtensionAPI) {
  let client: SchedulerClient | undefined;
  let exportedInstance: string | undefined;
  let seen = new Set<string>();
  const waiting = new Map<string, () => void>();
  const idleWaiters: Array<() => void> = [];
  let isIdle: () => boolean = () => true;

  // Branch from a settled turn, never from the middle of one.
  const whenIdle = () => isIdle() ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve));
  pi.on("agent_settled", () => { for (const resolve of idleWaiters.splice(0)) resolve(); });

  async function spawnFork(event: ScheduledEvent) {
    const { task, label } = forkRequest(event);
    await whenIdle();
    const args = ["fork", "--origin", `schedule:${event.series || event.id}`];
    args.push("--label", label || `scheduled: ${task.slice(0, 60)}`);
    const stamp = new Date(event.due_at).toLocaleString("en-US", { timeZone: process.env.FAMILIAR_TZ || "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit" });
    args.push(`(Scheduled${event.rule ? ` every ${event.rule}` : ""}, due ${stamp}. Nobody is waiting on you live; do the work, then imp merge.)\n\n${task}`);
    const { stdout } = await execFileAsync("imp", args, { env: process.env, timeout: 60_000, maxBuffer: 64 * 1024 });
    const forkId = String(stdout).trim().split("\n").pop() ?? "";
    // Durable before ack: a redelivery after a crash sees this and skips.
    pi.appendEntry(SCHEDULED_FORK, { id: event.id, forkId, series: event.series ?? "", task });
    seen.add(event.id);
    pi.sendMessage({
      customType: "familiar.fork-dispatched.v1",
      content: `\n\nscheduled fork ${forkId || "(unknown id)"} started${event.rule ? ` (every ${event.rule})` : ""}: ${label || task}\n(no action needed)`,
      display: true,
      details: { forkId, task, source: "schedule", eventId: event.id, series: event.series },
    }, { deliverAs: "nextTurn" });
  }

  pi.on("session_start", async (_event, ctx) => {
    const instance = ctx.sessionManager.getSessionId();
    if (!instance) { errorLog("scheduler", { error: "session has no id" }); return; }
    exportedInstance = instance;
    process.env.FAMILIAR_INSTANCE_ID = instance;
    seen = deliveredIds(ctx.sessionManager.getBranch());
    isIdle = () => ctx.isIdle();
    client = new SchedulerClient(instance, {
      event(event) {
        if (seen.has(event.id)) return;
        if (event.type === "fork") {
          // A failed spawn rejects: no ack, so reconnect redelivers it.
          return spawnFork(event).catch((error) => {
            errorLog("scheduler", { forkError: String(error), id: event.id });
            throw error;
          });
        }
        const message = renderScheduledEvent(event);
        if (event.urgency === "soft") {
          return new Promise<void>((resolve) => {
            waiting.set(event.id, resolve);
            pi.sendMessage(message, { deliverAs: "nextTurn" });
          });
        }
        pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
        seen.add(event.id);
      },
      error(error) { errorLog("scheduler", { error: error.message }); },
    });
    client.start();
  });
  // Pi persists queued nextTurn custom messages before turn_start. Ack only after
  // the event ID is visible in the durable branch; a restart before then causes
  // scheduler reconnect redelivery rather than losing an in-memory queue.
  pi.on("turn_start", (_event, ctx) => {
    const persisted = deliveredIds(ctx.sessionManager.getBranch());
    for (const id of persisted) {
      seen.add(id);
      const resolve = waiting.get(id);
      if (resolve) { waiting.delete(id); resolve(); }
    }
  });
  pi.on("session_shutdown", async () => {
    client?.stop(); client = undefined;
    if (process.env.FAMILIAR_INSTANCE_ID === exportedInstance) delete process.env.FAMILIAR_INSTANCE_ID;
    exportedInstance = undefined;
    waiting.clear();
    for (const resolve of idleWaiters.splice(0)) resolve();
    seen = new Set();
  });
}

// Soft (nextTurn) messages reach the model appended after the operator's text
// in the same user turn; Pi orders them after the user message and the router
// joins adjacent text blocks with nothing between. Lead with a blank line so a
// notice never runs into his words.
export const SOFT_SEPARATOR = "\n\n";

export function renderScheduledEvent(event: ScheduledEvent) {
  const lead = event.urgency === "soft" ? SOFT_SEPARATOR : "";
  if (event.type === "merge") {
    const merge = JSON.parse(event.body) as { summary: string; forkSessionId: string; forkSessionFile: string; branchEntryId: string; firstEntryId: string; lastEntryId: string; turnCount: number; forkedFurther: boolean; mergedAt: string };
    return {
      customType: "familiar.merge.v1",
      content: event.urgency === "soft" ? `${lead}fork ${merge.forkSessionId} merged: ${merge.summary}` : `<familiar-merge fork="${escapeAttr(merge.forkSessionId)}" branch="${escapeAttr(merge.branchEntryId)}" divergence="${merge.turnCount}" forked-further="${merge.forkedFurther}">\n${merge.summary}\nfull record: ${merge.forkSessionFile} entries ${merge.firstEntryId}..${merge.lastEntryId}\n</familiar-merge>`,
      display: true,
      details: { id: event.id, event, ...merge },
    };
  }
  return {
    customType: "scheduler-event",
    content: `${lead}<scheduler-event id="${escapeAttr(event.id)}" type="${escapeAttr(event.type)}" priority="${event.priority}" source="${escapeAttr(event.source)}">\n${event.body || event.summary}\n</scheduler-event>`,
    display: true,
    details: { id: event.id, event },
  };
}

export function forkRequest(event: ScheduledEvent): { task: string; label: string } {
  try {
    const body = JSON.parse(event.body) as { task?: unknown; label?: unknown };
    if (typeof body.task === "string" && body.task.trim()) return { task: body.task, label: typeof body.label === "string" ? body.label : "" };
  } catch { /* plain-text body */ }
  return { task: event.body || event.summary, label: "" };
}

export function deliveredIds(entries: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  // Pi persists sendMessage() output as `custom_message` entries with customType
  // and details at the top level; older sessions wrapped them in `message`.
  // Scheduled forks are recorded as plain `custom` entries (not model-visible).
  type Entry = { type?: string; customType?: string; data?: { id?: unknown }; details?: { id?: unknown }; message?: { customType?: string; details?: { id?: unknown } } };
  for (const entry of entries as Entry[]) {
    if (entry.type === "custom" && entry.customType === SCHEDULED_FORK && typeof entry.data?.id === "string") { ids.add(entry.data.id); continue; }
    const shape = entry.type === "custom_message" ? entry : entry.type === "message" ? entry.message : undefined;
    if ((shape?.customType === "scheduler-event" || shape?.customType === "familiar.merge.v1") && typeof shape.details?.id === "string") ids.add(shape.details.id);
  }
  return ids;
}
const escapeAttr = (value: string): string => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
export type { ScheduledEvent };
