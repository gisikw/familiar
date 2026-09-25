import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorLog } from "../lib/debug.ts";
import { SchedulerClient, type ScheduledEvent } from "./client.ts";

/** The Pi is only a scheduler transport endpoint: connect, inject, acknowledge. */
export default function (pi: ExtensionAPI) {
  let client: SchedulerClient | undefined;
  let exportedInstance: string | undefined;
  let seen = new Set<string>();
  const waiting = new Map<string, () => void>();

  pi.on("session_start", async (_event, ctx) => {
    const instance = ctx.sessionManager.getSessionId();
    if (!instance) { errorLog("scheduler", { error: "session has no id" }); return; }
    exportedInstance = instance;
    process.env.FAMILIAR_INSTANCE_ID = instance;
    seen = deliveredIds(ctx.sessionManager.getBranch());
    client = new SchedulerClient(instance, {
      event(event) {
        if (seen.has(event.id)) return;
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
    seen = new Set();
  });
}

export function renderScheduledEvent(event: ScheduledEvent) {
  if (event.type === "merge") {
    const merge = JSON.parse(event.body) as { summary: string; forkSessionId: string; forkSessionFile: string; branchEntryId: string; firstEntryId: string; lastEntryId: string; turnCount: number; forkedFurther: boolean; mergedAt: string };
    return {
      customType: "familiar.merge.v1",
      content: event.urgency === "soft" ? `fork ${merge.forkSessionId} merged: ${merge.summary}` : `<familiar-merge fork="${escapeAttr(merge.forkSessionId)}" branch="${escapeAttr(merge.branchEntryId)}" divergence="${merge.turnCount}" forked-further="${merge.forkedFurther}">\n${merge.summary}\nfull record: ${merge.forkSessionFile} entries ${merge.firstEntryId}..${merge.lastEntryId}\n</familiar-merge>`,
      display: true,
      details: { id: event.id, event, ...merge },
    };
  }
  return {
    customType: "scheduler-event",
    content: `<scheduler-event id="${escapeAttr(event.id)}" type="${escapeAttr(event.type)}" priority="${event.priority}" source="${escapeAttr(event.source)}">\n${event.body || event.summary}\n</scheduler-event>`,
    display: true,
    details: { id: event.id, event },
  };
}

function deliveredIds(entries: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries as Array<{ type?: string; message?: { customType?: string; details?: { id?: unknown } } }>) {
    if (entry.type === "message" && (entry.message?.customType === "scheduler-event" || entry.message?.customType === "familiar.merge.v1") && typeof entry.message.details?.id === "string") ids.add(entry.message.details.id);
  }
  return ids;
}
const escapeAttr = (value: string): string => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
export type { ScheduledEvent };
