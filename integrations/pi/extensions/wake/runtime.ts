import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatLocalTime, humanizeDuration } from "../lib/time.ts";
import {
  claimWake,
  ensureWakeDirs,
  loadWakes,
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

  constructor(
    private readonly host: WakeHost,
    root: string,
    private readonly clock: WakeClock = systemClock,
  ) {
    this.paths = wakePaths(root);
  }

  start(): void {
    if (this.started) return;
    ensureWakeDirs(this.paths);
    this.started = true;
    for (const wake of loadWakes(this.paths)) {
      // fired/ is the durable idempotence journal. This also handles a stale
      // backup restoring an already-claimed pending record.
      if (wasClaimed(this.paths, wake.id)) {
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

  freshInput(): void {
    if (!this.started) return;
    for (const wake of loadWakes(this.paths)) {
      if (wake.mode !== "unless_wakened" || wake.scheduledAt >= this.clock.now()) continue;
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
