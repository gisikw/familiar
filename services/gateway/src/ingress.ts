import type http from "http";
import { errorLog } from "./debug.ts";
import type { RelayBus } from "./relay.ts";
import type { SubmitPayload, VoiceStatusPayload } from "./protocol.ts";

function chunkLog(obj: Record<string, unknown>) {
  process.stderr.write(`[stt-chunk] ${JSON.stringify(obj)}\n`);
}

/* --- Ingress: text / chunked-audio takes → RelayCommand -------------------
 *
 * Ported from integrations/pi/extensions/subscriber/server.ts (handleSubmit + transcribe*).
 * The server owns STT (FAMILIAR_STT_URL): it transcribes audio takes here,
 * assembles the ready-to-dispatch text parts, and pushes a submit command
 * down the relay for the extension to enact against pi.sendUserMessage. The
 * extension appends the live editor draft and records the correlation echo.
 */

export class Ingress {
  private audioSegmentBuffer: Record<number, Record<number, { data: string; transcription: Promise<string> }>> = {};
  private voiceSeq = 0;

  constructor(private relay: RelayBus) { }

  private emitVoice(phase: VoiceStatusPayload["phase"], takeId?: number) {
    // Voice feedback is advisory: it must never make submit/cancel fail.
    try { this.relay.send({ type: "voice-status", phase, timestamp: Date.now(), seq: ++this.voiceSeq, takeId }); }
    catch (err) { errorLog("subscriber", { voiceStatusError: String(err) }); }
  }

  private parseVoiceStatus(raw: string): VoiceStatusPayload | null {
    try {
      const p = JSON.parse(raw);
      if ((p?.phase === "capturing" || p?.phase === "transcribing" || p?.phase === "idle")
        && typeof p.timestamp === "number" && Number.isFinite(p.timestamp)
        && (p.takeId === undefined || typeof p.takeId === "number")) return p;
    } catch { /* invalid */ }
    return null;
  }

  private parseSubmit(raw: string): SubmitPayload | null {
    try {
      const p = JSON.parse(raw);
      if (p?.type === "text" && typeof p.content === "string") return p;
      if (p?.type === "audio" && typeof p.id === "number" && typeof p.seq === "number"
        && typeof p.data === "string" && typeof p.segments === "number") return p;
    } catch { /* fall through to null */ }
    return null;
  }

  private transcribe(data: string): Promise<string> {
    const baseUrl = process.env.FAMILIAR_STT_URL;
    if (!baseUrl) return Promise.reject(new Error("FAMILIAR_STT_URL not set"));
    const url = `${baseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`;
    return fetch(url, { method: "POST", body: Buffer.from(data, "base64") })
      .then(async (res) => {
        if (!res.ok) throw new Error(`stt ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const { text } = await res.json();
        return typeof text === "string" ? text : "";
      });
  }

  // Retry with backoff long enough (~15s) to outlast an STT child restart
  // (deploys restart children; that is what produced the Oct 3 gaps). Only
  // then resolve to a bracketed placeholder so inference proceeds on the
  // segments we do have. Every chunk logs one line to stderr regardless of
  // FAMILIAR_DEBUG_LEVEL: chunk arrival timing is the voice-latency evidence.
  static retryDelaysMs = [500, 1000, 2000, 4000, 8000];
  private async transcribeWithRetry(data: string, take: number, seq: number): Promise<string> {
    const receivedAt = new Date();
    const bytes = Math.floor((data.length * 3) / 4);
    let attempts = 0;
    let lastErr: unknown;
    for (const delay of [0, ...Ingress.retryDelaysMs]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      attempts++;
      const started = Date.now();
      try {
        const text = await this.transcribe(data);
        chunkLog({ take, seq, bytes, receivedAt: receivedAt.toISOString(), sttMs: Date.now() - started, totalMs: Date.now() - receivedAt.getTime(), attempts, ok: true });
        return text;
      } catch (err) {
        lastErr = err;
      }
    }
    chunkLog({ take, seq, bytes, receivedAt: receivedAt.toISOString(), totalMs: Date.now() - receivedAt.getTime(), attempts, ok: false, error: String(lastErr).slice(0, 200) });
    errorLog("subscriber", { error: String(lastErr) });
    return "[transcribed segment missing]";
  }

  // correlationId: client-chosen submit id, echoed on the user message the
  // extension produces from these parts.
  private dispatch(correlationId: number | undefined, ...parts: string[]) {
    const clean = parts.filter((p) => typeof p === "string" && p.trim());
    if (!clean.length) return;
    this.relay.send({ type: "submit", correlationId, parts: clean });
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  // POST /voice-status — browser-side capture begins before audio exists.
  async handleVoiceStatus(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
    const payload = this.parseVoiceStatus(await this.readBody(req));
    if (!payload) { res.statusCode = 400; return res.end(); }
    this.emitVoice(payload.phase, payload.takeId);
    res.statusCode = 204;
    res.end();
  }

  // POST /cancel — abort the in-flight turn. Idempotent, 204 always.
  handleCancel(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end();
    }
    this.relay.send({ type: "cancel" });
    res.statusCode = 204;
    res.end();
  }

  async handleSubmit(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end();
    }

    const payload = this.parseSubmit(await this.readBody(req));
    if (payload === null) {
      res.statusCode = 400;
      return res.end();
    }

    if (payload.type === "text") {
      this.dispatch(payload.id, payload.content);
    } else {
      const { id, seq, data, segments } = payload;
      this.emitVoice("transcribing", id);
      const take = this.audioSegmentBuffer[id] = this.audioSegmentBuffer[id] || {};
      if (take[seq] === undefined) {
        take[seq] = { data, transcription: this.transcribeWithRetry(data, id, seq) };
      }

      if (segments && segments > 0) {
        const missingSegments = Array.from({ length: segments }, (_, i) => i)
          .filter((i) => take[i] === undefined);

        if (missingSegments.length) {
          res.statusCode = 409;
          res.write(JSON.stringify({ missing: missingSegments }));
        } else {
          const ordered = Array.from({ length: segments }, (_, i) => take[i]);
          Promise.all(ordered.map((seg) => seg.transcription))
            .then((transcriptions) => {
              // 🗣 marks transcribed speech so the model prices in STT errors;
              // payload.text is typed by the client and left unmarked.
              this.dispatch(id, `🗣 ${transcriptions.join(" ")}`, payload.text ?? "");
            })
            .catch((err) => {
              errorLog("subscriber", { dispatchError: String(err), id });
            })
            .finally(() => {
              this.emitVoice("idle", id);
              delete this.audioSegmentBuffer[id];
            });
        }
      }
    }

    res.end();
  }
}
