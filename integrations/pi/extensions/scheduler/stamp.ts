import { compactDuration, formatShortStamp } from "../lib/time.ts";

// Delivery timing. Soft (nextTurn) items wait in Pi's buffer and reach the
// model alongside Kev's next message, so without a stamp a merge from 14
// minutes ago reads as arriving with his words. Each scheduler-delivered item
// gets at= (when it happened) and, when it waited, queued= (how long before
// the turn that carried it). Applied in the `context` hook from timestamps
// already stored on the messages, so the output is deterministic and the
// prompt cache only shifts once, at deploy.

export const STAMPED_TYPES = new Set(["scheduler-event", "familiar.merge.v1", "familiar.fork-dispatched.v1"]);
/** Below this, "queued" is noise. */
export const QUEUED_FLOOR_MS = 60_000;

type Msg = { role?: string; customType?: string; content?: unknown; timestamp?: number; details?: Record<string, unknown> };

/** When the thing itself happened, not when Pi re-received it on a redelivery. */
export function occurredAt(msg: Msg): number | undefined {
  const d = msg.details ?? {};
  const event = (d.event ?? {}) as { due_at?: unknown; created_at?: unknown };
  if (msg.customType === "familiar.merge.v1" && typeof d.mergedAt === "string") {
    const t = Date.parse(d.mergedAt);
    if (Number.isFinite(t)) return t;
  }
  if (msg.customType === "scheduler-event" && typeof event.due_at === "number" && event.due_at > 1e12) return event.due_at;
  return typeof msg.timestamp === "number" ? msg.timestamp : undefined;
}

const attrs = (at: number, queued: number | undefined) =>
  ` at="${formatShortStamp(new Date(at))}"${queued !== undefined ? ` queued="${compactDuration(queued)}"` : ""}`;

/** Put the timing on the item's opening tag, or lead a plain-text notice with it. */
export function stampText(text: string, at: number, queued: number | undefined): string {
  if (/<(familiar-merge|scheduler-event)\b[^>]* at="/.test(text)) return text;
  const tag = text.match(/<(familiar-merge|scheduler-event)\b/);
  if (tag && tag.index !== undefined) {
    const end = tag.index + tag[0].length;
    return text.slice(0, end) + attrs(at, queued) + text.slice(end);
  }
  const lead = text.match(/^\s*/)?.[0] ?? "";
  const when = formatShortStamp(new Date(at));
  return `${lead}[${when}${queued !== undefined ? `, queued ${compactDuration(queued)}` : ""}] ${text.slice(lead.length)}`;
}

/** Stamp every scheduler-delivered message in a context window. The carrying
 * turn's time is the user message the item rode with (soft items follow it);
 * otherwise the item's own arrival. */
export function stampDeliveries<T extends Msg>(messages: T[]): T[] {
  let turnTs: number | undefined;
  return messages.map((msg) => {
    if (msg.role === "user") { turnTs = msg.timestamp; return msg; }
    if (msg.role !== "custom" || !msg.customType || !STAMPED_TYPES.has(msg.customType)) {
      if (msg.role !== "custom") turnTs = undefined;
      return msg;
    }
    const at = occurredAt(msg);
    if (at === undefined) return msg;
    const carried = turnTs ?? msg.timestamp ?? at;
    const wait = carried - at;
    const queued = wait >= QUEUED_FLOOR_MS ? wait : undefined;
    const content = msg.content;
    if (typeof content === "string") return { ...msg, content: stampText(content, at, queued) };
    if (Array.isArray(content)) {
      const i = content.findIndex((p) => p && (p as { type?: string }).type === "text");
      if (i < 0) return msg;
      const parts = content.slice();
      const part = parts[i] as { type: string; text: string };
      parts[i] = { ...part, text: stampText(part.text, at, queued) };
      return { ...msg, content: parts };
    }
    return msg;
  });
}
