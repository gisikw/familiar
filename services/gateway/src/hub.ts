import type http from "http";
import { randomUUID } from "crypto";
import { debugLog } from "./debug.ts";
import { HISTORY_MAX, type MessageEvent, type SessionEvent, type StreamEvent } from "./protocol.ts";

/* --- SSE hub: client registry, history replay, broadcast ------------------
 *
 * Ported faithfully from extensions/subscriber/hub.ts. Now server-owned: the
 * hub is fed by /ingest envelopes rather than an in-process firehose, and the
 * session epoch is re-mintable (newSession) because the id-space lives in the
 * extension firehose, which restarts with each pi session.
 */

export class StreamHub {
  private clients = new Set<{ res: http.ServerResponse; audio: boolean }>();
  private history: StreamEvent[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  inflight: MessageEvent | null = null;
  // Epoch identity. Re-minted on newSession(): clients compare across attaches
  // to detect a message-id-space reset (stale-cache poisoning).
  session: string = randomUUID();

  attach(req: http.IncomingMessage, res: http.ServerResponse, audio: boolean) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(":connected\n\n");
    // First event on EVERY attach, before replay — deliberately outside
    // history so it can never scroll off or be skipped by partial replay.
    this.write(res, { event: "session", id: this.session });
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

  // New pi session: re-mint the epoch and drop history so a reconnecting
  // client sees the new id (→ discard cached transcript) and clean replay.
  newSession() {
    this.session = randomUUID();
    this.history = [];
    this.inflight = null;
    const evt: SessionEvent = { event: "session", id: this.session };
    for (const c of this.clients) this.write(c.res, evt);
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

  private write(res: http.ServerResponse, event: StreamEvent | SessionEvent) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
