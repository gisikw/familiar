/* ============================================================================
 * Worklist policy — pure decision logic (no I/O, no pi, no timers)
 * ============================================================================
 *
 * This module is the load-bearing, headlessly-testable core of the worklist.
 * Everything here is a pure function of (item, attention, clock, config) so the
 * tier/attention/escalation matrix can be exercised without a running pi. The
 * extension (index.ts) owns side effects — delivery, persistence, timers — and
 * calls into here for every "what should happen to this item now?" decision.
 * See PROTOCOL.md for the design rationale.
 *
 * ATTENTION replaces the old two-state `posture`. It is a four-level discrete
 * enum, ordered by *decreasing* interruptibility:
 *
 *   open       — long-unoccupied; pull anything queued rather than sit idle.
 *   available  — ordinary working availability; important items surface.
 *   focused    — active/recent conversation; suppress ordinary interruptions.
 *   protected  — explicit, TIME-BOUNDED total suppression; hold everything
 *                incl. P0 until expiry or manual release. Manual only.
 *
 * `open | available | focused` are auto-inferred from activity. `protected`
 * (and a manual pin of `available`/`focused`) can only be set with a duration.
 */

/** Lower is more urgent, mirroring Unix nice / severity conventions. */
export type Priority = 0 | 1 | 2 | 3;

/**
 * Delivery tiers, ordered most-active → most-passive. A tier is *how* an item
 * reaches the conversation, never *whether* it is tracked — tracking is the
 * durable queue; delivery is a courtesy layered on top (presence.md).
 *
 *  steer  — deliver ASAP (next tool boundary), wake if idle, auto-ack.
 *  nudge  — one-line summary prefix on the next turn; body only on /ack.
 *  wait   — deliver+auto-ack once settled N min AND attention allows; else hold.
 *  linger — never delivered alone; folded into a single idle digest / /peek.
 */
export type Tier = "steer" | "nudge" | "wait" | "linger";

/** The four attention levels, ordered by decreasing interruptibility. */
export type Attention = "open" | "available" | "focused" | "protected";

/**
 * Manual override: "auto" hands the decision back to inference. Only the three
 * settable levels can be pinned; `open` cannot be entered manually — it is an
 * earned idle state.
 */
export type AttentionMode = "auto" | "available" | "focused" | "protected";

export type ItemType = "notify" | "question" | "review";

/* --- duration parsing (pure; lives here so tests avoid typebox in index) ---- */

/** Parse "30m" / "2h" / "--at 15:00" style durations to a deadline (ms epoch). */
export function parseWhen(spec: string, now = Date.now()): number | undefined {
  const s = spec.trim();
  const dur = s.match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)?$/i);
  if (dur) {
    const n = Number(dur[1]);
    const unit = (dur[2] || "m").toLowerCase();
    const mult = unit.startsWith("s") ? 1000
      : unit.startsWith("h") ? 3600_000
      : unit.startsWith("d") ? 86400_000
      : 60_000;
    return now + n * mult;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** Parse just a duration spec into milliseconds (for override durations). */
export function parseDurationMs(spec: string, now = Date.now()): number | undefined {
  const when = parseWhen(spec, now);
  return when === undefined ? undefined : when - now;
}

export interface QueueItem {
  id: string;
  ts: number;
  priority: Priority;
  type: ItemType;
  /** Short, for nudges and the widget. */
  summary: string;
  /** Full content, delivered on ack (or auto-ack for steer/wait). */
  body: string;
  source: string;
  /** Advisory timestamp (ms). Passing it promotes the item one tier, once. */
  suggested_deadline?: number;

  // --- delivery state (mutated by the extension, persisted with the item) ---
  /** Full body has reached the conversation. */
  delivered?: boolean;
  /** Acknowledged — either explicitly (/ack) or auto (steer/wait delivery). */
  acked?: boolean;
  /** Times the one-line summary has been surfaced as a nudge prefix. */
  surfacedCount?: number;
  /** Deadline-passed promotion has been latched (fires at most once). */
  escalated?: boolean;
  /** Folded into a linger digest already (so we don't repeat it every idle). */
  digested?: boolean;
  /** Wall-clock until which the item is suppressed entirely (/snooze). */
  snoozedUntil?: number;
  /**
   * Withdrawn: claimed elsewhere (e.g. subagent_await took ownership of a
   * settlement already queued here) so it must never surface. Terminal, like
   * acked, but it was never delivered. See the dedup invariant in PROTOCOL.md.
   */
  withdrawn?: boolean;
}

/** Ordering used for demote/promote arithmetic. */
const TIER_ORDER: Tier[] = ["steer", "nudge", "wait", "linger"];

const clampTier = (i: number): Tier => TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, i))];
/** More passive (focused attention). */
export const demote = (t: Tier): Tier => clampTier(TIER_ORDER.indexOf(t) + 1);
/** More active (open attention, or deadline escalation). */
export const promote = (t: Tier): Tier => clampTier(TIER_ORDER.indexOf(t) - 1);

export interface AttentionConfig {
  /** Per-priority base tier when attention is "available". */
  baseTier: Record<Priority, Tier>;
  /** Idle ms an item must wait before a "wait"-tier delivery fires. */
  waitSettleMs: number;
  /** Idle ms after which "focused" relaxes to "available". */
  settleToAvailableMs: number;
  /** Idle ms after which "available" relaxes to "open" (long-idle solicit). */
  settleToOpenMs: number;
  /** Idle ms of sustained quiet before a "linger" digest is offered. */
  lingerDigestMs: number;
  /** Hard ceiling for any manual override duration (clamp). */
  maxOverrideMs: number;
  /**
   * In "focused" attention, demote every priority one tier EXCEPT P0. This is
   * the whole point of attention: the same item is louder when Kevin is
   * available and quieter when he (or the agent) is heads-down.
   */
  demoteOnFocusedExceptP0: boolean;
}

/** Sane defaults, editable later (the config is a plain table on purpose). */
export const DEFAULT_CONFIG: AttentionConfig = {
  baseTier: { 0: "steer", 1: "nudge", 2: "wait", 3: "linger" },
  waitSettleMs: 5 * 60 * 1000,
  settleToAvailableMs: 2 * 60 * 1000,
  settleToOpenMs: 30 * 60 * 1000,
  lingerDigestMs: 5 * 60 * 1000,
  maxOverrideMs: 8 * 60 * 60 * 1000,
  demoteOnFocusedExceptP0: true,
};

/**
 * The core matrix: given an item, the current attention and clock, what tier
 * governs it right now?
 *
 *   protected → everything holds (short-circuit; the "driving home" guarantee).
 *   otherwise: escalation (deadline passed) promotes one tier, then the level
 *   transform applies — `open` promotes (except P0 already at steer), `focused`
 *   demotes (except P0), `available` is the base.
 *
 * Returns `"linger"` under protected only as a sentinel; callers must treat
 * protected via decideAction's hold short-circuit. resolveTier is still exposed
 * for /peek, which shows the *base* tier the item would take once attention
 * relaxes, so we compute it as if not protected here.
 */
export function resolveTier(
  item: QueueItem,
  attention: Attention,
  cfg: AttentionConfig = DEFAULT_CONFIG,
): Tier {
  let tier = cfg.baseTier[item.priority];
  if (item.escalated) tier = promote(tier);
  if (attention === "open" && item.priority !== 0) {
    // Idle: pull work forward one tier. P0 already steers; leave it.
    tier = promote(tier);
  } else if (attention === "focused" && cfg.demoteOnFocusedExceptP0 && item.priority !== 0) {
    tier = demote(tier);
  }
  // `protected` is handled by decideAction (all → hold); resolveTier reports the
  // tier the item would take at `available`-equivalent so /peek stays legible.
  return tier;
}

/** Has this item's advisory deadline passed without having been latched yet? */
export function shouldEscalate(item: QueueItem, now: number): boolean {
  return (
    !item.escalated &&
    typeof item.suggested_deadline === "number" &&
    now >= item.suggested_deadline
  );
}

/** An item is "live" (eligible for any delivery) unless resolved or snoozed. */
export function isLive(item: QueueItem, now: number): boolean {
  if (item.acked || item.withdrawn) return false;
  if (item.snoozedUntil && now < item.snoozedUntil) return false;
  return true;
}

/** Items that still occupy the queue for widget/peek purposes. */
export function isPending(item: QueueItem): boolean {
  return !item.acked && !item.withdrawn;
}

/* ============================================================================
 * Attention inference + override resolution
 * ============================================================================ */

/** A manual, time-bounded override. `expiresAt` is wall-clock ms epoch. */
export interface AttentionOverride {
  level: "available" | "focused" | "protected";
  expiresAt: number;
}

export interface AttentionInput {
  /** Live manual override, or null/undefined for pure inference. */
  override?: AttentionOverride | null;
  /** Last time the user did anything (input) or the agent worked. */
  lastActivity: number;
  /** Is the agent currently running (not idle)? */
  agentBusy: boolean;
  now: number;
}

/**
 * Resolve the current attention level. A LIVE manual override wins outright.
 * Otherwise infer from activity:
 *   agent working or very recent activity     → focused
 *   activity within settleToOpenMs            → available
 *   long-idle                                 → open
 *
 * Expiry is implicit and lazy: an override with `now >= expiresAt` is simply
 * not honoured, so correctness never depends on a timer firing. On expiry the
 * level returns DIRECTLY to inference — no staged decay.
 */
export function resolveAttention(
  input: AttentionInput,
  cfg: AttentionConfig = DEFAULT_CONFIG,
): Attention {
  const ov = input.override;
  if (ov && input.now < ov.expiresAt) return ov.level;
  if (input.agentBusy) return "focused";
  if (input.now - input.lastActivity < cfg.settleToAvailableMs) return "focused";
  if (input.now - input.lastActivity < cfg.settleToOpenMs) return "available";
  return "open";
}

/**
 * Clamp a requested override duration to (0, maxOverrideMs]. A non-positive or
 * NaN duration is invalid (returns null); anything above the ceiling is capped.
 * This is the single guarantee that no manual state can be unbounded.
 */
export function clampDuration(
  durationMs: number,
  cfg: AttentionConfig = DEFAULT_CONFIG,
): number | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  return Math.min(durationMs, cfg.maxOverrideMs);
}

/**
 * Build an override from a level + requested duration at `now`, clamped. Returns
 * null if the duration is invalid. `expiresAt` is absolute wall-clock so it
 * survives restart correctly.
 */
export function makeOverride(
  level: AttentionOverride["level"],
  durationMs: number,
  now: number,
  cfg: AttentionConfig = DEFAULT_CONFIG,
): AttentionOverride | null {
  const clamped = clampDuration(durationMs, cfg);
  if (clamped === null) return null;
  return { level, expiresAt: now + clamped };
}

/** True iff the override is absent or already expired at `now`. */
export function overrideExpired(ov: AttentionOverride | null | undefined, now: number): boolean {
  return !ov || now >= ov.expiresAt;
}

/**
 * Decide the concrete action for a live item on a scheduler tick. Pure so the
 * whole delivery ladder is testable; the extension performs the returned verb.
 *
 *   deliver-steer  — sendMessage steer + triggerTurn, then auto-ack
 *   deliver-wait   — sendMessage (no wake), then auto-ack
 *   nudge          — eligible to be surfaced as a one-line prefix next turn
 *   digest         — fold into the linger digest
 *   hold           — do nothing this tick
 */
export type Action = "deliver-steer" | "deliver-wait" | "nudge" | "digest" | "hold";

export interface TickInput {
  attention: Attention;
  now: number;
  /** ms the agent has been continuously idle (0 if currently busy). */
  idleForMs: number;
}

export function decideAction(
  item: QueueItem,
  input: TickInput,
  cfg: AttentionConfig = DEFAULT_CONFIG,
): Action {
  if (!isLive(item, input.now)) return "hold";
  // PROTECTED is the total floor: hold every priority, P0 included. This is the
  // one column unreachable by inference — only by an explicit, timed command.
  if (input.attention === "protected") return "hold";

  const tier = resolveTier(item, input.attention, cfg);

  switch (tier) {
    case "steer":
      return item.delivered ? "hold" : "deliver-steer";
    case "nudge":
      return item.delivered ? "hold" : "nudge";
    case "wait":
      if (item.delivered) return "hold";
      // Focused attention holds "wait" entirely; only deliver once genuinely
      // settled at available/open.
      if (input.attention === "focused") return "hold";
      return input.idleForMs >= cfg.waitSettleMs ? "deliver-wait" : "hold";
    case "linger":
      if (item.digested) return "hold";
      if (input.attention === "focused") return "hold";
      return input.idleForMs >= cfg.lingerDigestMs ? "digest" : "hold";
  }
}
