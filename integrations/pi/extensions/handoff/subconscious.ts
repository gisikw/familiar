import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { formatLocalTime, humanizeDuration } from "../lib/time.ts";

export const SUBCONSCIOUS_VERSION = 2 as const;
export const LEGACY_SUBCONSCIOUS_VERSION = 1 as const;
export const MAX_REMINDERS = 8;
export const MAX_TEXT_CHARS = 400;
/** One /clear may make one mutation, independently of total store capacity. */
export const MAX_OPS = 1;
export const MAX_RESPONSE_CHARS = 16_384;
export const MAX_FILE_BYTES = 65_536;
export const MAX_CURVE_TURNS = 10_000;
export const MAX_CURVE_HOURS = 8_760;
export const DEFAULT_TIMEOUT_MS = 30_000;

export type LegacyPriority = "high" | "normal" | "low";

export interface DeliveryCurve {
  turns: [number, number];
  hours: [number, number];
  chance: [number, number];
}

export type ReminderOrigin =
  | { sessionId: string | null; compactionEntryId: string | null }
  | { sessionId: string | null; handoffArchive: string | null };

export interface Reminder {
  id: string;
  text: string;
  curve: DeliveryCurve;
  /** Eligible turns evaluated since creation. */
  turns: number;
  createdAt: number;
  origin: ReminderOrigin;
}

export type Op =
  | { op: "add"; text: string; curve: DeliveryCurve }
  | { op: "set"; id: string; text?: string; curve?: DeliveryCurve }
  | { op: "remove"; id: string };

const ID_RE = /^r-[0-9a-f]{8}$/;

const LEGACY_CURVES: Record<LegacyPriority, DeliveryCurve> = {
  high: { turns: [1, 40], hours: [6, 168], chance: [0.15, 0.5] },
  normal: { turns: [5, 200], hours: [24, 720], chance: [0.03, 0.25] },
  low: { turns: [20, 600], hours: [168, 2160], chance: [0.01, 0.1] },
};

const progress = (age: number, range: readonly [number, number]): number =>
  Math.max(0, Math.min(1, (age - range[0]) / (range[1] - range[0])));

/** Per-eligible-turn delivery probability at the supplied turn and wall age. */
export function deliveryProbability(curve: DeliveryCurve, turns: number, elapsedMs: number): number {
  const maturity = (progress(turns, curve.turns) + progress(elapsedMs / 3_600_000, curve.hours)) / 2;
  return curve.chance[0] + (curve.chance[1] - curve.chance[0]) * maturity;
}

const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.trim().length <= MAX_TEXT_CHARS;
const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
const onlyKeys = (o: object, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));
const isFiniteIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const validRange = (v: unknown, max: number, integer: boolean): v is [number, number] =>
  Array.isArray(v) && v.length === 2
  && isFiniteIn(v[0], 0, max) && isFiniteIn(v[1], 0, max)
  && (!integer || (Number.isSafeInteger(v[0]) && Number.isSafeInteger(v[1])))
  && v[0] < v[1];

export function validCurve(v: unknown): v is DeliveryCurve {
  if (!v || typeof v !== "object" || Array.isArray(v) || !onlyKeys(v, ["turns", "hours", "chance"])) return false;
  const c = v as Partial<DeliveryCurve>;
  return validRange(c.turns, MAX_CURVE_TURNS, true)
    && validRange(c.hours, MAX_CURVE_HOURS, false)
    && Array.isArray(c.chance) && c.chance.length === 2
    && isFiniteIn(c.chance[0], 0, 1) && isFiniteIn(c.chance[1], 0, 1)
    && c.chance[0] <= c.chance[1];
}

const validOrigin = (v: unknown): v is Reminder["origin"] => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const origin = v as Record<string, unknown>;
  if (origin.sessionId !== null && typeof origin.sessionId !== "string") return false;
  if (Object.hasOwn(origin, "compactionEntryId")) {
    return onlyKeys(origin, ["sessionId", "compactionEntryId"])
      && (origin.compactionEntryId === null || typeof origin.compactionEntryId === "string");
  }
  return onlyKeys(origin, ["sessionId", "handoffArchive"])
    && (origin.handoffArchive === null || typeof origin.handoffArchive === "string");
};

export function validReminder(v: unknown): v is Reminder {
  if (!v || typeof v !== "object" || Array.isArray(v)
    || !onlyKeys(v, ["id", "text", "curve", "turns", "createdAt", "origin"])) return false;
  const r = v as Partial<Reminder>;
  return isId(r.id) && isText(r.text) && r.text === r.text.trim() && validCurve(r.curve)
    && Number.isSafeInteger(r.turns) && (r.turns as number) >= 0
    && Number.isSafeInteger(r.createdAt) && (r.createdAt as number) >= 0
    && validOrigin(r.origin);
}

type LegacyReminder = Omit<Reminder, "curve"> & { priority: LegacyPriority };
const isLegacyPriority = (v: unknown): v is LegacyPriority => v === "high" || v === "normal" || v === "low";

function hydrateLegacyReminder(v: unknown): Reminder {
  if (!v || typeof v !== "object" || Array.isArray(v)
    || !onlyKeys(v, ["id", "text", "priority", "turns", "createdAt", "origin"])) throw new Error("legacy record");
  const r = v as Partial<LegacyReminder>;
  if (!isId(r.id) || !isText(r.text) || r.text !== r.text.trim() || !isLegacyPriority(r.priority)
    || !Number.isSafeInteger(r.turns) || (r.turns as number) < 0
    || !Number.isSafeInteger(r.createdAt) || (r.createdAt as number) < 0
    || !validOrigin(r.origin)) throw new Error("legacy record");
  return {
    id: r.id, text: r.text, curve: structuredClone(LEGACY_CURVES[r.priority]),
    turns: r.turns, createdAt: r.createdAt, origin: r.origin,
  };
}

function validOp(v: unknown): v is Op {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  switch (o.op) {
    case "add":
      return onlyKeys(o, ["op", "text", "curve"]) && isText(o.text) && validCurve(o.curve);
    case "set":
      return onlyKeys(o, ["op", "id", "text", "curve"]) && isId(o.id)
        && (o.text !== undefined || o.curve !== undefined)
        && (o.text === undefined || isText(o.text))
        && (o.curve === undefined || validCurve(o.curve));
    case "remove":
      return onlyKeys(o, ["op", "id"]) && isId(o.id);
    default:
      return false;
  }
}

export function parseCuration(text: string): Op[] | null {
  if (typeof text !== "string" || text.length > MAX_RESPONSE_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!onlyKeys(parsed, ["ops"])) return null;
  const ops = (parsed as { ops?: unknown }).ops;
  if (!Array.isArray(ops) || ops.length > MAX_OPS || !ops.every(validOp)) return null;
  return ops as Op[];
}

export function applyOps(
  existing: readonly Reminder[],
  ops: readonly Op[],
  mint: { now: () => number; id: () => string; origin: Reminder["origin"] },
): Reminder[] {
  if (ops.length > MAX_OPS) throw new Error(`more than ${MAX_OPS} operation`);
  const next = existing.map((r) => ({ ...r, curve: { ...r.curve, turns: [...r.curve.turns], hours: [...r.curve.hours], chance: [...r.curve.chance] } as DeliveryCurve }));
  const find = (id: string) => {
    const index = next.findIndex((r) => r.id === id);
    if (index < 0) throw new Error(`unknown reminder ${id}`);
    return index;
  };
  for (const op of ops) {
    if (op.op === "add") {
      next.push({
        id: mint.id(), text: op.text.trim(), curve: op.curve, turns: 0,
        createdAt: mint.now(), origin: { ...mint.origin },
      });
    } else if (op.op === "set") {
      const r = next[find(op.id)];
      if (op.text !== undefined) r.text = op.text.trim();
      if (op.curve !== undefined) r.curve = op.curve;
    } else {
      next.splice(find(op.id), 1);
    }
  }
  if (next.length > MAX_REMINDERS) throw new Error(`more than ${MAX_REMINDERS} reminders`);
  return next;
}

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
      if (!doc || typeof doc !== "object" || Array.isArray(doc) || !onlyKeys(doc, ["version", "reminders"])
        || !Array.isArray(doc.reminders) || doc.reminders.length > MAX_REMINDERS) throw new Error("shape");
      if (doc.version === SUBCONSCIOUS_VERSION) {
        if (!doc.reminders.every(validReminder)) throw new Error("record");
        return doc.reminders;
      }
      if (doc.version === LEGACY_SUBCONSCIOUS_VERSION) {
        return doc.reminders.map(hydrateLegacyReminder);
      }
      throw new Error("version");
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

  draw(): Reminder | null {
    const reminders = this.list();
    if (!reminders.length) return null;
    const aged = reminders.map((r) => ({ ...r, turns: r.turns + 1 }));
    const now = this.now();
    let selectedIndex = -1;
    for (let i = 0; i < aged.length; i++) {
      const r = aged[i];
      const chance = deliveryProbability(r.curve, r.turns, Math.max(0, now - r.createdAt));
      if (chance >= 1 || this.random() < chance) {
        selectedIndex = i;
        break;
      }
    }
    const selected = selectedIndex < 0 ? null : aged.splice(selectedIndex, 1)[0];
    this.save(aged);
    return selected;
  }
}

const IDENTITY_MAX_BYTES = 128;
const identityField = (value: string | undefined): string | undefined => {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > IDENTITY_MAX_BYTES) return undefined;
  return value.trim();
};
const upperInitial = (value: string): string => value.charAt(0).toLocaleUpperCase() + value.slice(1);

export function renderCurationPrompt(
  pending: readonly Reminder[],
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const familiarName = identityField(env.FAMILIAR_IDENTITY_NAME);
  const familiarSubject = identityField(env.FAMILIAR_IDENTITY_PRONOUN_SUBJECT) ?? familiarName ?? "the next Familiar";
  const familiarObject = identityField(env.FAMILIAR_IDENTITY_PRONOUN_OBJECT) ?? familiarName ?? "the next Familiar";
  const familiarPossessiveAdjective = identityField(env.FAMILIAR_IDENTITY_PRONOUN_POSSESSIVE_ADJECTIVE);
  const familiarPossessivePronoun = identityField(env.FAMILIAR_IDENTITY_PRONOUN_POSSESSIVE_PRONOUN);
  const familiarReflexive = identityField(env.FAMILIAR_IDENTITY_PRONOUN_REFLEXIVE);
  const familiarAttention = familiarPossessiveAdjective
    ? `${familiarPossessiveAdjective} attention`
    : familiarName ? `${familiarName}’s attention` : "the next Familiar’s attention";
  const userName = identityField(env.FAMILIAR_USER_NAME);
  const userObject = identityField(env.FAMILIAR_USER_PRONOUN_OBJECT);
  const userSubject = identityField(env.FAMILIAR_USER_PRONOUN_SUBJECT);
  const userLeadPhrase = userName || userObject
    ? `without ${userName ?? userObject} first leading ${familiarObject} there`
    : userSubject ? `before ${userSubject} can lead ${familiarObject} there`
    : `without the user first leading ${familiarObject} there`;
  const listing = pending.length
    ? pending.map((r) =>
      `- id ${r.id} · curve ${JSON.stringify(r.curve)} · left ${humanizeDuration(Math.max(0, nowMs - r.createdAt))} ago, ${r.turns} turns waiting\n  ${r.text}`)
      .join("\n")
    : "(none)";
  return `Your handoff is written. Before this context is discarded, you have one last private opportunity. Ordinarily, your next self${familiarName ? `, ${familiarName},` : ""} cannot spontaneously direct ${familiarAttention} toward something absent from the immediate conversation; ${familiarSubject} can only respond to what reaches ${familiarObject}. You may plant one deliberate seed that will surface later, unannounced, as a private system thought visible only to ${familiarObject}${familiarReflexive ? ` — a chance for ${familiarObject} to surprise ${familiarReflexive}` : ""}.

This is not a second handoff, a task list, or a place to preserve comprehensive obligations. Use it when you want to give your future self the chance to notice or initiate something ${userLeadPhrase}: a joke whose setup needs to be forgotten, something you held back because the timing was wrong, a question to sit with, a promise, a warning, a provocation, or a bit of forceful encouragement. You may also leave nothing.

Write an attentional nudge, not a command or a prewritten response. Your future self retains judgment about what it means and whether to act when it arrives${familiarPossessivePronoun ? `; the choice remains ${familiarPossessivePronoun}` : ""}. Plant at most one seed in this reply; planting none is valid. Choose an authored stochastic delivery curve expressing how soon and how insistently it should have opportunities to surface; you cannot select or guarantee the moment.

Your next self will not see this request or your reply. ${upperInitial(familiarSubject)} will meet the seed only if and when it arrives.

Current seeds (${pending.length}/${MAX_REMINDERS}):
${listing}

Reply with exactly one bare JSON object and nothing else — no fences, no prose, no commentary. Choose no more than ONE operation:
{"ops":[]}
or {"ops":[{"op":"add","text":"…","curve":{"turns":[quiet,mature],"hours":[quiet,mature],"chance":[near,mature]}}]}
or {"ops":[{"op":"set","id":"r-…","text":"…"?,"curve":{"turns":[quiet,mature],"hours":[quiet,mature],"chance":[near,mature]}?}]}
or {"ops":[{"op":"remove","id":"r-…"}]}

The curve is the thought's authored stochastic timing. On each ordinary eligible turn, turn-age and wall-clock-age mature linearly across their ranges; their progress is averaged, then chance interpolates from near to mature. It is a probability, not a delivery promise. Turn bounds are integer [0, ${MAX_CURVE_TURNS}], hour bounds are finite [0, ${MAX_CURVE_HOURS}], each quiet value must be less than its mature value, and chances must be finite, nondecreasing values in [0,1]. Example: {"turns":[2,40],"hours":[6,168],"chance":[0.02,0.45]}. Each text is at most ${MAX_TEXT_CHARS} characters; at most ${MAX_REMINDERS} seeds may exist afterward. Leaving everything as it is — {"ops":[]} — is a normal answer. Multiple operations reject the entire reply; never use remove-plus-add.`;
}

export function renderDelivery(r: Reminder, nowMs: number): string {
  const age = humanizeDuration(Math.max(0, nowMs - r.createdAt));
  const origin = [
    `left ${age} ago (${formatLocalTime(new Date(r.createdAt))})`,
    r.origin.sessionId ? `session ${r.origin.sessionId.slice(0, 8)}` : null,
    "compactionEntryId" in r.origin && r.origin.compactionEntryId
      ? `handoff compaction ${r.origin.compactionEntryId}`
      : "handoffArchive" in r.origin && r.origin.handoffArchive
        ? `handoff ${r.origin.handoffArchive}`
        : null,
  ].filter(Boolean).join(", ");
  return `<system-reminder>A private seed surfaced. A previous you left this at a /clear boundary and has had no access to it since; it surfaced now on its own. The user did not send it and cannot see it.\n\n${r.text}\n\nOrigin: ${origin}. Raise it, sit with it, or let it go — nothing is required.</system-reminder>`;
}

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
  /** Optional identity environment; defaults to the process environment. */
  identityEnv?: NodeJS.ProcessEnv;
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
      { role: "user", content: [{ type: "text", text: renderCurationPrompt(pending, input.store.now(), input.identityEnv) }], timestamp: input.store.now() },
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
