import { compactDuration, formatShortStamp } from "../lib/time.ts";

// Delivery timing. Soft (nextTurn) items wait in Pi's buffer and reach the
// model alongside Kev's next message, so without a stamp a merge from 14
// minutes ago reads as arriving with his words. Each scheduler-delivered item
// gets at= (when it happened) and, when it waited, queued= (how long before
// the turn that carried it). Applied in the `context` hook.
//
// RULE (Oct 18 2026, Kev): a context-hook rendering must be a pure function of
// what is serialized in the session, or its output must be written back into
// the session. Pi's `timestamp` on a custom message is NOT such a field: live
// it holds the sendMessage() time, rebuilt from disk it holds the time Pi
// persisted it (which, for a nextTurn notice, is when Kev's next message
// carried it, hours later). Reading it made a fork's rebuilt prefix differ from
// the parent's live one at the first notice, so forks rewrote the whole cache
// (state/docs/fork-cache/PROPOSAL.md). So: times come from `details`, which
// is persisted verbatim, and never from a custom message's own timestamp.
// context-determinism.test.ts enforces this for every extension's hook.

export const STAMPED_TYPES = new Set(["scheduler-event", "familiar.merge.v1", "familiar.fork-dispatched.v1"]);
/** Below this, "queued" is noise. */
export const QUEUED_FLOOR_MS = 60_000;

type Msg = { role?: string; customType?: string; content?: unknown; timestamp?: number; details?: Record<string, unknown> };

/** Key the scheduler writes into `details` at sendMessage() time. */
export const SENT_AT = "sentAt";

/** Add the send time to a stamped message's details, so the stamp never needs
 * the message's own (live-vs-persisted) timestamp. */
export function withSentAt<M extends { customType?: string; details?: unknown }>(message: M, now = Date.now()): M {
  if (!message.customType || !STAMPED_TYPES.has(message.customType)) return message;
  const details = (message.details ?? {}) as Record<string, unknown>;
  if (typeof details[SENT_AT] === "number") return message;
  return { ...message, details: { ...details, [SENT_AT]: now } };
}

const ms = (v: unknown): number | undefined => {
  if (typeof v === "number" && v > 1e12) return v;
  if (typeof v === "string") { const t = Date.parse(v); if (Number.isFinite(t)) return t; }
  return undefined;
};

/** A UUIDv7's first 48 bits are its creation time in ms. Fork ids are v7, so a
 * legacy dispatch notice (no sentAt) still has a persisted dispatch time. */
export function uuidV7Time(id: unknown): number | undefined {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(id)) return undefined;
  const t = parseInt(id.replace(/-/g, "").slice(0, 12), 16);
  return t > 1e12 ? t : undefined;
}

/** When the thing itself happened, not when Pi re-received it on a redelivery.
 * Persisted fields only (see RULE above). */
export function occurredAt(msg: Msg): number | undefined {
  const d = msg.details ?? {};
  const event = (d.event ?? {}) as { due_at?: unknown; created_at?: unknown };
  switch (msg.customType) {
    case "familiar.merge.v1": return ms(d.mergedAt) ?? ms(d[SENT_AT]);
    case "scheduler-event": return ms(event.due_at) ?? ms(event.created_at) ?? ms(d[SENT_AT]);
    case "familiar.fork-dispatched.v1": return ms(d[SENT_AT]) ?? uuidV7Time(d.forkId);
    default: return undefined;
  }
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
 * otherwise the time the scheduler sent it (details.sentAt); otherwise it
 * counts as prompt. A user message's timestamp is set once at creation and
 * persisted unchanged, so it is safe to read. */
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
    const carried = turnTs ?? ms(msg.details?.[SENT_AT]) ?? at;
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
