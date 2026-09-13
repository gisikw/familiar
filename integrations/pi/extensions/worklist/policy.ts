/* Worklist delivery and Do Not Disturb policy. Pure: no I/O or timers. */

export type Priority = 0 | 1 | 2 | 3;
export type Tier = "steer" | "nudge" | "wait" | "linger";
export type ItemType = "notify" | "question" | "review";
export type DndActor = "user" | "familiar";

export interface QueueItem {
  id: string;
  ts: number;
  priority: Priority;
  type: ItemType;
  summary: string;
  body: string;
  source: string;
  suggested_deadline?: number;
  delivered?: boolean;
  acked?: boolean;
  surfacedCount?: number;
  escalated?: boolean;
  digested?: boolean;
  digestedAt?: number;
  snoozedUntil?: number;
  withdrawn?: boolean;
}

export interface DndState {
  enabled: true;
  setBy: DndActor;
  setAt: number;
  expiresAt: number;
}

export interface WorklistConfig {
  baseTier: Record<Priority, Tier>;
  waitSettleMs: number;
  lingerDigestMs: number;
  digestAckGraceMs: number;
  digestReminderMs: number;
  defaultDndMs: number;
  familiarMaxDndMs: number;
  maxDeliveriesPerTick: number;
}

export const DEFAULT_CONFIG: WorklistConfig = {
  baseTier: { 0: "steer", 1: "nudge", 2: "wait", 3: "linger" },
  waitSettleMs: 30_000,
  lingerDigestMs: 5 * 60_000,
  digestAckGraceMs: 30 * 60_000,
  digestReminderMs: 5 * 60_000,
  defaultDndMs: 30 * 60_000,
  familiarMaxDndMs: 2 * 60 * 60_000,
  maxDeliveriesPerTick: 1,
};

export function parseWhen(spec: string, now = Date.now()): number | undefined {
  const s = spec.trim();
  const dur = s.match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)?$/i);
  if (dur) {
    const n = Number(dur[1]);
    const unit = (dur[2] || "m").toLowerCase();
    const mult = unit.startsWith("s") ? 1000 : unit.startsWith("h") ? 3_600_000 : unit.startsWith("d") ? 86_400_000 : 60_000;
    return now + n * mult;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

export function parseDurationMs(spec: string, now = Date.now()): number | undefined {
  const when = parseWhen(spec, now);
  return when === undefined ? undefined : when - now;
}

/** Authoritative construction boundary. Familiar requests are capped at two hours. */
export function makeDnd(
  actor: DndActor,
  requestedMs: number | undefined,
  now: number,
  cfg: WorklistConfig = DEFAULT_CONFIG,
): DndState | null {
  const duration = requestedMs === undefined ? cfg.defaultDndMs : requestedMs;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const bounded = actor === "familiar" ? Math.min(duration, cfg.familiarMaxDndMs) : duration;
  return { enabled: true, setBy: actor, setAt: now, expiresAt: now + bounded };
}

export function dndActive(state: DndState | null | undefined, now: number): state is DndState {
  return !!state && state.enabled === true && now < state.expiresAt;
}

/** Validate disk state and re-enforce the Familiar cap after restart. */
export function sanitizeDnd(raw: unknown, now: number, cfg: WorklistConfig = DEFAULT_CONFIG): DndState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<DndState>;
  if (value.enabled !== true || (value.setBy !== "user" && value.setBy !== "familiar")) return null;
  if (typeof value.setAt !== "number" || !Number.isFinite(value.setAt) || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return null;
  if (value.expiresAt <= now || value.expiresAt <= value.setAt) return null;
  const expiresAt = value.setBy === "familiar"
    ? Math.min(value.expiresAt, value.setAt + cfg.familiarMaxDndMs, now + cfg.familiarMaxDndMs)
    : value.expiresAt;
  if (expiresAt <= now) return null;
  return { enabled: true, setBy: value.setBy, setAt: value.setAt, expiresAt };
}

const ORDER: Tier[] = ["steer", "nudge", "wait", "linger"];
export const promote = (tier: Tier): Tier => ORDER[Math.max(0, ORDER.indexOf(tier) - 1)];

export function resolveTier(item: QueueItem, cfg: WorklistConfig = DEFAULT_CONFIG): Tier {
  const tier = cfg.baseTier[item.priority];
  return item.escalated ? promote(tier) : tier;
}

export function shouldEscalate(item: QueueItem, now: number): boolean {
  return !item.escalated && typeof item.suggested_deadline === "number" && now >= item.suggested_deadline;
}

export function isLive(item: QueueItem, now: number): boolean {
  return !item.acked && !item.withdrawn && !(item.snoozedUntil && now < item.snoozedUntil);
}

export function isPending(item: QueueItem): boolean {
  return !item.acked && !item.withdrawn;
}

export type Action = "deliver-steer" | "deliver-wait" | "nudge" | "digest" | "hold";
export function decideAction(
  item: QueueItem,
  input: { dnd: boolean; now: number; idleForMs: number },
  cfg: WorklistConfig = DEFAULT_CONFIG,
): Action {
  if (!isLive(item, input.now) || input.dnd) return "hold";
  if (item.digested) {
    if (typeof item.digestedAt !== "number" || input.now - item.digestedAt < cfg.digestAckGraceMs) return "hold";
    return input.idleForMs >= cfg.waitSettleMs ? "deliver-wait" : "hold";
  }
  switch (resolveTier(item, cfg)) {
    case "steer": return item.delivered ? "hold" : "deliver-steer";
    case "nudge":
      if (item.delivered) return "hold";
      return input.idleForMs >= cfg.waitSettleMs ? "deliver-wait" : "nudge";
    case "wait":
      if (item.delivered) return "hold";
      return input.idleForMs >= cfg.waitSettleMs ? "deliver-wait" : "hold";
    case "linger": return input.idleForMs >= cfg.lingerDigestMs ? "digest" : "hold";
  }
}
