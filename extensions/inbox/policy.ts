/* ============================================================================
 * Inbox policy — pure decision logic (no I/O, no pi, no timers)
 * ============================================================================
 *
 * This module is the load-bearing, headlessly-testable core of the inbox.
 * Everything here is a pure function of (item, posture, clock, config) so the
 * tier/posture/escalation matrix can be exercised without a running pi. The
 * extension (index.ts) owns side effects — delivery, persistence, timers —
 * and calls into here for every "what should happen to this item now?"
 * decision. See PROTOCOL.md for the design rationale.
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
 *  wait   — deliver+auto-ack once settled N min AND posture allows; else hold.
 *  linger — never delivered alone; folded into a single idle digest / /peek.
 */
export type Tier = "steer" | "nudge" | "wait" | "linger";

/** Posture is an inferred (or overridden) state of the whole channel. */
export type Posture = "available" | "busy";

/** Manual override: "auto" hands the decision back to inference. */
export type PostureMode = "auto" | "available" | "busy";

export type ItemType = "notify" | "question" | "review";

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
}

/** Ordering used for demote/promote arithmetic. */
const TIER_ORDER: Tier[] = ["steer", "nudge", "wait", "linger"];

const clampTier = (i: number): Tier => TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, i))];
/** More passive (busy posture). */
export const demote = (t: Tier): Tier => clampTier(TIER_ORDER.indexOf(t) + 1);
/** More active (deadline escalation). */
export const promote = (t: Tier): Tier => clampTier(TIER_ORDER.indexOf(t) - 1);

export interface PostureConfig {
  /** Per-priority base tier when posture is "available". */
  baseTier: Record<Priority, Tier>;
  /** Idle ms an item must wait before a "wait"-tier delivery fires. */
  waitSettleMs: number;
  /** Idle ms after which "available" is re-inferred (settle → available). */
  settleToAvailableMs: number;
  /** Idle ms of sustained quiet before a "linger" digest is offered. */
  lingerDigestMs: number;
  /**
   * In "busy" posture, demote every priority one tier EXCEPT P0. This is the
   * whole point of posture: the same item is louder when Kevin is available
   * and quieter when he (or the agent) is heads-down.
   */
  demoteOnBusyExceptP0: boolean;
}

/** Sane defaults, editable later (the config is a plain table on purpose). */
export const DEFAULT_CONFIG: PostureConfig = {
  baseTier: { 0: "steer", 1: "nudge", 2: "wait", 3: "linger" },
  waitSettleMs: 5 * 60 * 1000,
  settleToAvailableMs: 2 * 60 * 1000,
  lingerDigestMs: 5 * 60 * 1000,
  demoteOnBusyExceptP0: true,
};

/**
 * The core matrix: given an item, the current posture and clock, what tier
 * governs it right now? Escalation (deadline passed) is applied first as a
 * one-tier promotion, then busy-posture demotion. P0 is never demoted.
 */
export function resolveTier(
  item: QueueItem,
  posture: Posture,
  cfg: PostureConfig = DEFAULT_CONFIG,
): Tier {
  let tier = cfg.baseTier[item.priority];
  if (item.escalated) tier = promote(tier);
  if (posture === "busy" && cfg.demoteOnBusyExceptP0 && item.priority !== 0) {
    tier = demote(tier);
  }
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
  if (item.acked) return false;
  if (item.snoozedUntil && now < item.snoozedUntil) return false;
  return true;
}

/** Items that still occupy the queue for widget/peek purposes. */
export function isPending(item: QueueItem): boolean {
  return !item.acked;
}

export interface PostureInput {
  mode: PostureMode;
  /** Last time the user did anything (input) or the agent worked. */
  lastActivity: number;
  /** Is the agent currently running (not idle)? */
  agentBusy: boolean;
  now: number;
}

/**
 * Infer posture. Manual override wins. Otherwise: any recent activity or a
 * working agent means "busy"; we only fall back to "available" once the agent
 * has been settled AND there has been no interaction for settleToAvailableMs.
 */
export function inferPosture(
  input: PostureInput,
  cfg: PostureConfig = DEFAULT_CONFIG,
): Posture {
  if (input.mode === "busy") return "busy";
  if (input.mode === "available") return "available";
  if (input.agentBusy) return "busy";
  if (input.now - input.lastActivity < cfg.settleToAvailableMs) return "busy";
  return "available";
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
  posture: Posture;
  now: number;
  /** ms the agent has been continuously idle (0 if currently busy). */
  idleForMs: number;
}

export function decideAction(
  item: QueueItem,
  input: TickInput,
  cfg: PostureConfig = DEFAULT_CONFIG,
): Action {
  if (!isLive(item, input.now)) return "hold";
  const tier = resolveTier(item, input.posture, cfg);

  switch (tier) {
    case "steer":
      return item.delivered ? "hold" : "deliver-steer";
    case "nudge":
      return item.delivered ? "hold" : "nudge";
    case "wait":
      if (item.delivered) return "hold";
      // Busy posture holds "wait" entirely; only deliver once genuinely settled.
      if (input.posture === "busy") return "hold";
      return input.idleForMs >= cfg.waitSettleMs ? "deliver-wait" : "hold";
    case "linger":
      if (item.digested) return "hold";
      if (input.posture === "busy") return "hold";
      return input.idleForMs >= cfg.lingerDigestMs ? "digest" : "hold";
  }
}
