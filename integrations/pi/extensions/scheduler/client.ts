import { createConnection, type Socket } from "node:net";
import { familiarServicesSocket } from "../lib/familiar-services.ts";

export interface ScheduledEvent {
  id: string; due_at: number; target: string; origin: string; source: string;
  priority: number; type: string; summary: string; body: string; state: string; created_at: number;
}
export type SchedulerCallbacks = { event(event: ScheduledEvent): void | Promise<void>; error(error: Error): void };

/** One reconnecting, long-lived scheduler stream. */
export class SchedulerClient {
  private socket?: Socket;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private delay = 250;
  constructor(private readonly instance: string, private readonly callbacks: SchedulerCallbacks, private readonly path = familiarServicesSocket()) {}
  start(): void { if (!this.stopped) return; this.stopped = false; this.connect(); }
  stop(): void { this.stopped = true; if (this.retry) clearTimeout(this.retry); this.retry = undefined; this.socket?.destroy(); this.socket = undefined; }
  private connect(): void {
    if (this.stopped) return;
    const socket = createConnection(this.path);
    this.socket = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => { this.delay = 250; socket.write(`${JSON.stringify({ op: "hello", args: { instance: this.instance } })}\n`); });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) return socket.destroy(new Error("scheduler record exceeds 1 MiB"));
      for (;;) {
        const end = buffer.indexOf("\n"); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
        try {
          const message = JSON.parse(line) as { event?: ScheduledEvent; ok?: boolean; error?: { message?: string } };
          if (message.event) void Promise.resolve(this.callbacks.event(message.event)).then(() => this.ack(message.event!.id), (error) => this.callbacks.error(asError(error)));
          else if (message.ok === false) this.callbacks.error(new Error(message.error?.message || "scheduler request failed"));
        } catch (error) { socket.destroy(asError(error)); }
      }
    });
    socket.on("error", (error) => this.callbacks.error(error));
    socket.on("close", () => { if (this.socket === socket) this.socket = undefined; if (!this.stopped) { const wait = this.delay; this.delay = Math.min(this.delay * 2, 10_000); this.retry = setTimeout(() => this.connect(), wait); } });
  }
  private ack(id: string): void { this.socket?.write(`${JSON.stringify({ op: "schedule.ack", args: { id } })}\n`); }
}
const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
