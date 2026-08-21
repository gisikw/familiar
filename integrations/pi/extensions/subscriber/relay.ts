import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { debugLog, errorLog } from "../lib/debug.ts";
import {
  INGRESS_DISPOSITION,
  RELAY_QUEUE_MAX,
  type IngestEnvelope,
  type MessageEvent,
  type RelayCommand,
  type StreamEvent,
} from "./protocol.ts";
import type { PendingEchoes } from "./echo.ts";

/* --- Thin relay: extension ⇄ familiar server ------------------------------
 *
 * The HTTP server used to live in-process. It now runs standalone on
 * localhost:1692 and owns all HTTP. This module is the extension's side:
 *
 *   RelayHub    — egress. Presents the exact hub interface the Firehose
 *                 expects (publish / revise / lockInflight / anyAudioListener
 *                 / inflight) but instead of broadcasting, POSTs one
 *                 IngestEnvelope per operation to /ingest. Degrades to a small
 *                 bounded queue when the server is down; never throws.
 *   NoopAudio   — the server owns TTS now, so the firehose's audio.register
 *                 calls are no-ops here. `synthesizing` is decided server-side.
 *   RelayClient — ingress. Subscribes to /relay (SSE) and enacts submit/cancel
 *                 commands against the pi API (sendUserMessage / abort), which
 *                 only the extension can reach.
 */

function baseUrl(): string {
  const port = process.env.FAMILIAR_SUBSCRIBER_PORT ?? process.env.FAMILIAR_SERVER_PORT ?? "1692";
  const host = process.env.FAMILIAR_SERVER_HOST ?? "127.0.0.1";
  return `http://${host}:${port}`;
}

export class RelayHub {
  // Firehose reads this in onAgentEnd; revise sets it, lockInflight clears it.
  inflight: MessageEvent | null = null;
  private queue: IngestEnvelope[] = [];
  private flushing = false;

  publish(event: StreamEvent) { this.enqueue({ kind: "publish", event }); }

  revise(event: MessageEvent) {
    this.inflight = event;
    this.enqueue({ kind: "revise", event });
  }

  lockInflight() {
    this.inflight = null;
    this.enqueue({ kind: "lock" });
  }

  // Server owns the audio-listener registry and overrides `synthesizing` on
  // ingest, so the extension can always report false here.
  anyAudioListener(): boolean { return false; }

  // Announce a fresh pi session so the server re-mints its epoch id and clears
  // history (message-id space reset contract).
  announceSession() { this.enqueue({ kind: "session" }); }

  private enqueue(env: IngestEnvelope) {
    this.queue.push(env);
    if (this.queue.length > RELAY_QUEUE_MAX) this.queue.splice(0, this.queue.length - RELAY_QUEUE_MAX);
    void this.flush();
  }

  // Drain the queue one envelope at a time. On failure (server down) the
  // envelope stays at the head and we stop; the next enqueue retries. Bounded,
  // lossy under sustained outage, never throwing into pi.
  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const env = this.queue[0];
        try {
          const res = await fetch(`${baseUrl()}/ingest`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(env),
            signal: AbortSignal.timeout(2000),
          });
          if (!res.ok) throw new Error(`ingest ${res.status}`);
          this.queue.shift();
        } catch (err) {
          debugLog("relay", { ingestDropPending: String(err), depth: this.queue.length });
          break; // leave head queued; next enqueue re-attempts
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

export class NoopAudio {
  register(_messageId: number, _index: number, _text: string, _synthesize: boolean) { /* server-side now */ }
}

export class RelayClient {
  ctx: ExtensionContext | null = null;
  private abort: AbortController | null = null;
  private closed = false;

  constructor(private pi: ExtensionAPI, private echoes: PendingEchoes) { }

  // Subscribe to the server's command bus. Reconnects with backoff; the server
  // may not be up yet at session_start.
  start() {
    this.closed = false;
    void this.loop();
  }

  close() {
    this.closed = true;
    this.abort?.abort();
    this.abort = null;
  }

  private async loop() {
    while (!this.closed) {
      this.abort = new AbortController();
      try {
        const res = await fetch(`${baseUrl()}/relay`, {
          headers: { Accept: "text/event-stream" },
          signal: this.abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`relay ${res.status}`);
        await this.consume(res.body);
      } catch (err) {
        if (this.closed) return;
        debugLog("relay", { relayDisconnected: String(err) });
      }
      if (this.closed) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private async consume(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (; ;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          try { this.enact(JSON.parse(json) as RelayCommand); }
          catch (err) { errorLog("relay", { enactError: String(err) }); }
        }
      }
    }
  }

  private enact(cmd: RelayCommand) {
    if (cmd.type === "cancel") {
      try { this.ctx?.abort?.(); } catch (err) { errorLog("relay", { cancelError: String(err) }); }
      return;
    }
    if (cmd.type === "submit") this.sendParts(cmd.correlationId, ...cmd.parts);
  }

  // Ported from the old SubscriberManager.sendParts: append the live editor
  // draft, record the echo for correlation, dispatch via the pi API.
  private sendParts(correlationId: number | undefined, ...parts: string[]) {
    const draft = this.ctx?.ui?.getEditorText?.() ?? "";
    debugLog("sendPartsDebug", { draft });
    const dispatchParts = parts
      .concat([draft])
      .map((part) => ({ type: "text" as const, text: part }))
      .filter((part) => typeof part.text === "string" && !!part.text.trim());
    if (!dispatchParts.length) return;
    if (correlationId !== undefined) {
      // Must mirror messageText(): text parts joined with "".
      this.echoes.push(correlationId, dispatchParts.map((p) => p.text).join(""));
    }
    this.pi.sendUserMessage(dispatchParts, { deliverAs: INGRESS_DISPOSITION });
    if (draft.trim()) this.ctx?.ui?.setEditorText?.("");
  }
}
