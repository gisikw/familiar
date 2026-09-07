import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatLocalTime, humanizeDuration } from "../lib/time.ts";
import {
  claimWake,
  ensureWakeDirs,
  loadWakes,
  migrateLegacyWakes,
  putWake,
  removePendingWake,
  wakePaths,
  wasClaimed,
  type WakeMode,
  type WakeRecord,
} from "./store.ts";

const MAX_TIMER_MS = 2_147_000_000;

export interface WakeClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
  id(): string;
}

const systemClock: WakeClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  id: () => randomUUID(),
};

export interface WakeHost {
  sendMessage: ExtensionAPI["sendMessage"];
}

export class WakeRuntime {
  private readonly paths;
  private readonly timers = new Map<string, unknown>();
  private started = false;
  // Other extensions can report durable ingress during their session_start
  // before wake's own lifecycle handler runs. Retain that timestamp so overdue
  // unless_wakened records are cancelled before they can be armed at delay 0.
  private lastFreshInputAt = 0;

  constructor(
    private readonly host: WakeHost,
    root: string,
    private readonly clock: WakeClock = systemClock,
    private readonly legacyRoots: readonly string[] = [],
  ) {
    this.paths = wakePaths(root);
  }

  start(): void {
    if (this.started) return;
    ensureWakeDirs(this.paths);
    // Ingest the bounded, first-release fallback locations before loading or
    // arming anything. In particular, legacy fired claims must win over every
    // pending collision so a restart cannot replay an already-attempted wake.
    migrateLegacyWakes(this.paths, this.legacyRoots);
    this.started = true;
    for (const wake of loadWakes(this.paths)) {
      // fired/ is the durable idempotence journal. This also handles a stale
      // backup restoring an already-claimed pending record.
      if (wasClaimed(this.paths, wake.id)) {
        removePendingWake(this.paths, wake.id);
        continue;
      }
      // Worklist announces queued/incoming work with its durable timestamp.
      // Honor an announcement made before this lifecycle handler as well as the
      // common wake-first ordering handled by the cancellable delay-0 timer.
      if (wake.mode === "unless_wakened" && wake.scheduledAt < this.lastFreshInputAt) {
        removePendingWake(this.paths, wake.id);
        continue;
      }
      this.arm(wake);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
    this.started = false;
  }

  schedule(mode: WakeMode, reason: string, durationMs: number): WakeRecord {
    this.start();
    const scheduledAt = this.clock.now();
    const wake: WakeRecord = {
      version: 1,
      id: `wake-${scheduledAt}-${this.clock.id()}`,
      mode,
      reason,
      scheduledAt,
      fireAt: scheduledAt + durationMs,
    };
    // Persistence precedes acknowledgement to the model: a successfully
    // returned tool call always has a durable alarm behind it.
    putWake(this.paths, wake);
    this.arm(wake);
    return wake;
  }

  freshInput(at = this.clock.now()): void {
    if (!Number.isSafeInteger(at) || at < 0) return;
    this.lastFreshInputAt = Math.max(this.lastFreshInputAt, at);
    if (!this.started) return;
    for (const wake of loadWakes(this.paths)) {
      if (wake.mode !== "unless_wakened" || wake.scheduledAt >= at) continue;
      this.cancel(wake.id);
    }
  }

  private cancel(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.timers.delete(id);
    removePendingWake(this.paths, id);
  }

  private arm(wake: WakeRecord): void {
    if (this.timers.has(wake.id)) return;
    const delay = wake.fireAt - this.clock.now();
    if (delay <= 0) {
      // Defer to the event loop so session_start finishes binding all other
      // extensions before an overdue wake starts a model turn.
      this.timers.set(wake.id, this.clock.setTimeout(() => this.fire(wake), 0));
      return;
    }
    const slice = Math.min(delay, MAX_TIMER_MS);
    this.timers.set(wake.id, this.clock.setTimeout(() => {
      this.timers.delete(wake.id);
      this.arm(wake);
    }, slice));
  }

  private fire(wake: WakeRecord): void {
    this.timers.delete(wake.id);
    try {
      if (!claimWake(this.paths, wake)) return;
    } catch {
      // A transient state-filesystem failure must not become an uncaught timer
      // exception in Presence. The record is still pending, so retry later.
      this.timers.set(wake.id, this.clock.setTimeout(() => this.fire(wake), 1_000));
      return;
    }
    const elapsed = Math.max(0, this.clock.now() - wake.scheduledAt);
    try {
      this.host.sendMessage(
        {
          customType: "wake",
          content:
            `<system-reminder>Scheduled wake ${wake.id} firing (mode: ${wake.mode}), ` +
            `set ${humanizeDuration(elapsed)} ago at ${formatLocalTime(new Date(wake.scheduledAt))}. ` +
            `Reason: ${wake.reason}</system-reminder>`,
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      // The durable claim deliberately remains: retrying after an ambiguous
      // send failure could duplicate a message already accepted by Pi.
    }
  }
}
