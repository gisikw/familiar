import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { formatLocalTime, humanizeDuration } from "../lib/time.ts";

/* --- Subconscious reminders ------------------------------------------------
 *
 * A small set of notes the outgoing Familiar curates for the next one, in one
 * ephemeral inference at `/clear` time: after her handoff exists, before the
 * compaction lands, with her full context still in hand. The request and the
 * strict-JSON reply never enter session history. The next Familiar never sees
 * that turn; she only ever receives reminders one at a time, unbidden, as a
 * hidden system reminder on an ordinary human turn.
 *
 * This module is pure Node with injectable clock, randomness, and ids. The
 * pi wiring lives in ./index.ts.
 */

export const SUBCONSCIOUS_VERSION = 1 as const;
export const MAX_REMINDERS = 8;
export const MAX_TEXT_CHARS = 400;
export const MAX_OPS = 16;
export const MAX_RESPONSE_CHARS = 16_384;
export const MAX_FILE_BYTES = 65_536;
/**
 * The curation request is awaited inside `session_before_compact`, so it is
 * added latency on an interactive `/clear`, and Pi cancels a manual compaction
 * outright when its signal aborts during the hook — interrupting a stuck
 * curation therefore throws away a handoff that is already written. The timeout
 * is the only graceful exit, so it is bounded well under a minute; the reply is
 * a few hundred tokens of JSON capped at 2048. Override with
 * FAMILIAR_SUBCONSCIOUS_TIMEOUT_MS for slow local models.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

export type Priority = "high" | "normal" | "low";
export const PRIORITIES: readonly Priority[] = ["high", "normal", "low"];

export interface Reminder {
  id: string;
  text: string;
  priority: Priority;
  /** Eligible turns evaluated since creation. */
  turns: number;
  createdAt: number;
  origin: { sessionId: string | null; handoffArchive: string | null };
}

export type Op =
  | { op: "add"; text: string; priority: Priority }
  | { op: "set"; id: string; text?: string; priority?: Priority }
  | { op: "remove"; id: string };

const ID_RE = /^r-[0-9a-f]{8}$/;

/* --- delivery curve ---
 *
 * Priority is the whole delivery language. Per eligible turn the chance is 0
 * inside the grace window, ramps linearly to a ceiling, and becomes certain at
 * `mustBy`, so the set provably drains.
 */
const CURVES: Record<Priority, { grace: number; start: number; end: number; ramp: number; mustBy: number }> = {
  high: { grace: 1, start: 0.15, end: 0.5, ramp: 15, mustBy: 40 },
  normal: { grace: 5, start: 0.03, end: 0.25, ramp: 60, mustBy: 200 },
  low: { grace: 20, start: 0.01, end: 0.1, ramp: 200, mustBy: 600 },
};

export function hazard(priority: Priority, turns: number): number {
  const c = CURVES[priority];
  if (turns <= c.grace) return 0;
  if (turns >= c.mustBy) return 1;
  return c.start + (c.end - c.start) * Math.min(1, (turns - c.grace) / c.ramp);
}

/* --- validation --- */

const isPriority = (v: unknown): v is Priority => PRIORITIES.includes(v as Priority);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.trim().length <= MAX_TEXT_CHARS;
const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
const onlyKeys = (o: object, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));

export function validReminder(v: unknown): v is Reminder {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<Reminder>;
  return isId(r.id) && isText(r.text) && r.text === r.text.trim() && isPriority(r.priority)
    && Number.isSafeInteger(r.turns) && (r.turns as number) >= 0
    && Number.isSafeInteger(r.createdAt) && (r.createdAt as number) >= 0
    && !!r.origin && typeof r.origin === "object"
    && (r.origin.sessionId === null || typeof r.origin.sessionId === "string")
    && (r.origin.handoffArchive === null || typeof r.origin.handoffArchive === "string");
}

function validOp(v: unknown): v is Op {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  switch (o.op) {
    case "add":
      return onlyKeys(o, ["op", "text", "priority"]) && isText(o.text) && isPriority(o.priority);
    case "set":
      return onlyKeys(o, ["op", "id", "text", "priority"]) && isId(o.id)
        && (o.text !== undefined || o.priority !== undefined)
        && (o.text === undefined || isText(o.text))
        && (o.priority === undefined || isPriority(o.priority));
    case "remove":
      return onlyKeys(o, ["op", "id"]) && isId(o.id);
    default:
      return false;
  }
}

/**
 * Strict parse of the curation reply. A single JSON object `{"ops":[...]}`,
 * optionally inside one ```json fence. Anything else is null: no mutation.
 */
export function parseCuration(text: string): Op[] | null {
  if (typeof text !== "string" || text.length > MAX_RESPONSE_CHARS) return null;
  let body = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(body);
  if (fenced) body = fenced[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!onlyKeys(parsed, ["ops"])) return null;
  const ops = (parsed as { ops?: unknown }).ops;
  if (!Array.isArray(ops) || ops.length > MAX_OPS || !ops.every(validOp)) return null;
  return ops as Op[];
}

/**
 * Apply ops in order to a copy of the set. All-or-nothing: an unknown id or a
 * result over MAX_REMINDERS throws and the caller keeps the original set.
 */
export function applyOps(
  existing: readonly Reminder[],
  ops: readonly Op[],
  mint: { now: () => number; id: () => string; origin: Reminder["origin"] },
): Reminder[] {
  const next = existing.map((r) => ({ ...r }));
  const find = (id: string) => {
    const index = next.findIndex((r) => r.id === id);
    if (index < 0) throw new Error(`unknown reminder ${id}`);
    return index;
  };
  for (const op of ops) {
    if (op.op === "add") {
      next.push({
        id: mint.id(), text: op.text.trim(), priority: op.priority, turns: 0,
        createdAt: mint.now(), origin: { ...mint.origin },
      });
    } else if (op.op === "set") {
      const r = next[find(op.id)];
      if (op.text !== undefined) r.text = op.text.trim();
      if (op.priority !== undefined) r.priority = op.priority;
    } else {
      next.splice(find(op.id), 1);
    }
  }
  if (next.length > MAX_REMINDERS) throw new Error(`more than ${MAX_REMINDERS} reminders`);
  return next;
}

/* --- store --- */

export function subconsciousRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FAMILIAR_SUBCONSCIOUS_DIR) return path.resolve(env.FAMILIAR_SUBCONSCIOUS_DIR);
  if (env.PI_CODING_AGENT_DIR) return path.join(path.dirname(path.resolve(env.PI_CODING_AGENT_DIR)), "subconscious");
  return path.resolve(".familiar-subconscious");
}

export interface StoreOptions {
  now?: () => number;
  random?: () => number;
  id?: () => string;
}

/** One 0600 JSON file, replaced atomically. Unreadable content reads as empty and is set aside, never overwritten in place. */
export class SubconsciousStore {
  readonly file: string;
  readonly now: () => number;
  readonly random: () => number;
  readonly id: () => string;

  constructor(readonly root: string, options: StoreOptions = {}) {
    this.file = path.join(root, "reminders.json");
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.id = options.id ?? (() => `r-${randomBytes(4).toString("hex")}`);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe subconscious directory: ${root}`);
    fs.chmodSync(root, 0o700);
  }

  list(): Reminder[] {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(this.file);
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("unsafe");
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const doc = parsed as { version?: unknown; reminders?: unknown };
      if (doc?.version !== SUBCONSCIOUS_VERSION || !Array.isArray(doc.reminders)) throw new Error("shape");
      if (doc.reminders.length > MAX_REMINDERS || !doc.reminders.every(validReminder)) throw new Error("record");
      return doc.reminders;
    } catch {
      try { fs.renameSync(this.file, `${this.file}.${this.now()}.corrupt`); } catch { /* leave it */ }
      return [];
    }
  }

  save(reminders: readonly Reminder[]): void {
    if (reminders.length > MAX_REMINDERS || !reminders.every(validReminder)) throw new Error("refusing to store invalid reminders");
    const temporary = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify({ version: SUBCONSCIOUS_VERSION, reminders })}\n`);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.file);
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* absent */ }
      throw error;
    }
  }

  /**
   * One eligible turn: every reminder ages; at most one is selected, removed
   * durably, and returned. At-most-once by design — a crash after the write
   * and before the model sees it loses that reminder rather than repeating it.
   */
  draw(): Reminder | null {
    const reminders = this.list();
    if (!reminders.length) return null;
    let selected: Reminder | null = null;
    const kept: Reminder[] = [];
    for (const r of reminders) {
      const aged = { ...r, turns: r.turns + 1 };
      const chance = hazard(aged.priority, aged.turns);
      if (!selected && (chance >= 1 || this.random() < chance)) selected = aged;
      else kept.push(aged);
    }
    this.save(kept);
    return selected;
  }
}

/* --- prompts --- */

export function renderCurationPrompt(pending: readonly Reminder[], nowMs: number): string {
  const listing = pending.length
    ? pending.map((r) =>
      `- id ${r.id} · ${r.priority} · left ${humanizeDuration(Math.max(0, nowMs - r.createdAt))} ago, ${r.turns} turns waiting\n  ${r.text}`)
      .join("\n")
    : "(none)";
  return `Your handoff is written. Before this context is discarded, one last private task: curate the subconscious reminders your next self will carry. These are not the handoff — they surface on their own, one at a time, unannounced, in ordinary conversation later, as a system reminder only you see. Use them for what should resurface rather than be filed: a question to sit with, a thread to revisit, a joke, a promise, a thing not to forget about someone. Your next self will not see this request or your reply; she only meets the reminders when they arrive.

Current reminders (${pending.length}/${MAX_REMINDERS}):
${listing}

Reply with exactly one JSON object and nothing else — no prose, no commentary:
{"ops":[
  {"op":"add","text":"…","priority":"high"|"normal"|"low"},
  {"op":"set","id":"r-…","text":"…"?,"priority":"…"?},
  {"op":"remove","id":"r-…"}
]}

Priority is the timing: "high" surfaces within roughly the next few dozen exchanges, "normal" drifts in over the next couple hundred, "low" is far out. Each text is at most ${MAX_TEXT_CHARS} characters; at most ${MAX_REMINDERS} reminders may exist afterward. Leaving everything as it is — {"ops":[]} — is a normal answer.`;
}

export function renderDelivery(r: Reminder, nowMs: number): string {
  const age = humanizeDuration(Math.max(0, nowMs - r.createdAt));
  const origin = [
    `left ${age} ago (${formatLocalTime(new Date(r.createdAt))})`,
    r.origin.sessionId ? `session ${r.origin.sessionId.slice(0, 8)}` : null,
    r.origin.handoffArchive ? `handoff ${r.origin.handoffArchive}` : null,
  ].filter(Boolean).join(", ");
  return `<system-reminder>Subconscious reminder. A previous you left this for you at a /clear boundary and has had no access to it since; it surfaced now on its own. The user did not send it and cannot see it.\n\n${r.text}\n\nOrigin: ${origin}. Raise it, sit with it, or let it go — nothing is required.</system-reminder>`;
}

/* --- the one ephemeral request --- */

export type LlmMessage = { role: "user" | "assistant"; content: unknown; timestamp?: number } & Record<string, unknown>;
export type CurationResponse = { stopReason: string; errorMessage?: string; content: readonly any[] };

export interface CurateInput {
  /** The outgoing Familiar's context as sent for the handoff, handoff prompt included. */
  messages: readonly LlmMessage[];
  handoff: string;
  store: SubconsciousStore;
  origin: Reminder["origin"];
  complete: (messages: LlmMessage[], signal: AbortSignal) => Promise<CurationResponse>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type CurateOutcome =
  | { outcome: "applied"; ops: number; reminders: number }
  | { outcome: "noop" }
  | { outcome: "skipped"; reason: string };

const responseText = (response: CurationResponse): string =>
  (response.content ?? [])
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");

/**
 * Exactly one dispatch. Every failure mode — abort, timeout, provider error,
 * empty or malformed reply, an op that does not validate, a store fault —
 * resolves to `skipped` with the set untouched. This never throws, so the
 * caller's compaction cannot be wedged by it.
 */
export async function curate(input: CurateInput): Promise<CurateOutcome> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (input.signal?.aborted) return { outcome: "skipped", reason: "aborted" };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const pending = input.store.list();
    const messages: LlmMessage[] = [
      ...input.messages,
      { role: "assistant", content: [{ type: "text", text: input.handoff }], timestamp: input.store.now() },
      { role: "user", content: [{ type: "text", text: renderCurationPrompt(pending, input.store.now()) }], timestamp: input.store.now() },
    ];
    const response = await Promise.race([
      input.complete(messages, controller.signal),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })),
    ]);
    if (controller.signal.aborted) return { outcome: "skipped", reason: "aborted" };
    if (response.stopReason !== "stop") return { outcome: "skipped", reason: `stopReason:${response.stopReason}` };
    const ops = parseCuration(responseText(response));
    if (!ops) return { outcome: "skipped", reason: "invalid-json" };
    if (!ops.length) return { outcome: "noop" };
    // Re-read so ops apply to exactly what the model was shown, then verify no
    // one changed it underneath us; a mismatch is a skip, not a guess.
    const current = input.store.list();
    if (JSON.stringify(current) !== JSON.stringify(pending)) return { outcome: "skipped", reason: "store-changed" };
    const next = applyOps(current, ops, { now: input.store.now, id: input.store.id, origin: input.origin });
    input.store.save(next);
    return { outcome: "applied", ops: ops.length, reminders: next.length };
  } catch (error) {
    const reason = controller.signal.aborted && !input.signal?.aborted
      ? "timeout"
      : error instanceof Error ? error.name : "error";
    return { outcome: "skipped", reason };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
