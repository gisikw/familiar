import { serviceCall } from "../lib/familiar-services.ts";

export type WakeMode = "unless_wakened" | "always";
export interface WakeRecord {
  version: 1;
  id: string;
  mode: WakeMode;
  reason: string;
  scheduledAt: number;
  fireAt: number;
}

/** Thin client; familiar-services owns persistence and every wake timer. */
export class WakeClient {
  constructor(private readonly socketPath?: string) {}
  schedule(mode: WakeMode, reason: string, durationMinutes: number): Promise<WakeRecord> {
    return serviceCall("wake.schedule", { mode, reason, duration_minutes: durationMinutes }, this.socketPath);
  }
  cancel(id: string): Promise<{ cancelled: boolean }> { return serviceCall("wake.cancel", { id }, this.socketPath); }
  list(): Promise<WakeRecord[]> { return serviceCall("wake.list", {}, this.socketPath); }

  /** M2 cancels unless_wakened on worklist enqueue. Direct Pi activity has no
   * protocol operation, so the client closes that gap by listing and cancelling
   * older interruptible wakes. */
  async freshActivity(at = Date.now()): Promise<void> {
    const wakes = await this.list();
    await Promise.all(wakes.filter((wake) => wake.mode === "unless_wakened" && wake.scheduledAt < at).map((wake) => this.cancel(wake.id)));
  }
}
