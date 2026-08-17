import http from "http";
import { debugLog } from "../lib/debug.ts";
import { HISTORY_MAX, type MessageEvent, type StreamEvent } from "./protocol.ts";

/* --- SSE hub: client registry, history replay, broadcast ------------------ */

export class StreamHub {
  private clients = new Set<{ res: http.ServerResponse; audio: boolean }>();
  private history: StreamEvent[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  inflight: MessageEvent | null = null;

  attach(req: http.IncomingMessage, res: http.ServerResponse, audio: boolean) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(":connected\n\n");
    for (const event of this.history) this.write(res, event);
    if (this.inflight) this.write(res, this.inflight);

    const client = { res, audio };
    this.clients.add(client);
    req.on("close", () => this.clients.delete(client));

    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        for (const c of this.clients) c.res.write(":hb\n\n");
      }, 25_000);
    }
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }

  anyAudioListener(): boolean {
    for (const c of this.clients) if (c.audio) return true;
    return false;
  }

  // Locked events: recorded in history and broadcast.
  publish(event: StreamEvent) {
    this.history.push(event);
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    this.broadcast(event);
  }

  // Mutable revisions: broadcast only; replaced by the locked final.
  revise(event: MessageEvent) {
    this.inflight = event;
    this.broadcast(event);
  }

  lockInflight() {
    this.inflight = null;
  }

  private broadcast(event: StreamEvent) {
    debugLog("egress", event);
    for (const c of this.clients) this.write(c.res, event);
  }

  private write(res: http.ServerResponse, event: StreamEvent) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
