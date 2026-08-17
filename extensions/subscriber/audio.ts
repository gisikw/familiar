import http from "http";
import { debugLog, errorLog } from "../lib/debug.ts";
import { AUDIO_CACHE_MAX } from "./protocol.ts";
import type { StreamHub } from "./hub.ts";

/* --- Audio: segment cache + sequential synthesis queue -------------------- */

type AudioEntry = { text: string; status: "pending" | "ready" | "failed"; wav?: Buffer };

export class AudioCache {
  private entries = new Map<string, AudioEntry>();
  private queue: Promise<void> = Promise.resolve();
  private synthesizing = new Set<string>();

  constructor(private hub: StreamHub) { }

  register(messageId: number, index: number, text: string, synthesize: boolean) {
    const key = `${messageId}:${index}`;
    if (this.entries.has(key)) return;
    this.entries.set(key, { text, status: "pending" });
    while (this.entries.size > AUDIO_CACHE_MAX) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    if (synthesize) this.enqueue(messageId, index);
  }

  // 200 ready / 202 synthesizing (kicks synthesis if idle; retry) /
  // 404 unknown-or-evicted (terminal) / 503 synthesis failed.
  serve(messageId: number, index: number, res: http.ServerResponse) {
    debugLog("subscriber", { serve: `${messageId}:${index}`, status: this.entries.get(`${messageId}:${index}`)?.status ?? "absent" });
    const entry = this.entries.get(`${messageId}:${index}`);
    if (!entry) {
      res.statusCode = 404;
      return res.end();
    }
    if (entry.status === "ready" && entry.wav) {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": entry.wav.length });
      return res.end(entry.wav);
    }
    if (entry.status === "failed") {
      res.statusCode = 503;
      return res.end();
    }
    this.enqueue(messageId, index);
    res.writeHead(202, { "Retry-After": "1" });
    res.end();
  }

  private enqueue(messageId: number, index: number) {
    const key = `${messageId}:${index}`;
    if (this.synthesizing.has(key)) return;
    this.synthesizing.add(key);
    this.queue = this.queue.then(async () => {
      const entry = this.entries.get(key);
      if (!entry || entry.status !== "pending") return;
      try {
        const url = process.env.FAMILIAR_TTS_URL;
        if (!url) throw new Error("FAMILIAR_TTS_URL not set");
        const res = await fetch(`${url}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input: entry.text,
            ...(process.env.FAMILIAR_TTS_VOICE ? { voice: process.env.FAMILIAR_TTS_VOICE } : {}),
          }),
          signal: AbortSignal.timeout(300_000),
        });
        if (!res.ok) throw new Error(`tts ${res.status}`);
        entry.wav = Buffer.from(await res.arrayBuffer());
        entry.status = "ready";
        this.hub.publish({ event: "segment_audio", message_id: messageId, index, ok: true });
      } catch (err) {
        entry.status = "failed";
        errorLog("subscriber", { ttsError: String(err), key });
        this.hub.publish({ event: "segment_audio", message_id: messageId, index, ok: false });
      }
    });
  }
}
