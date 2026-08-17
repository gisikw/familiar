import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import http from "http";
import { debugLog, errorLog } from "../lib/debug.ts";
import { INGRESS_DISPOSITION, type SubmitPayload } from "./protocol.ts";
import { StreamHub } from "./hub.ts";
import { AudioCache } from "./audio.ts";
import { PendingEchoes } from "./echo.ts";

/* --- HTTP server + ingress ------------------------------------------------ */

export class SubscriberManager {
  private server: http.Server;
  private pi: ExtensionAPI;
  private audioSegmentBuffer;
  public ctx: ExtensionContext;
  public hub = new StreamHub();
  public audio = new AudioCache(this.hub);
  public echoes = new PendingEchoes();

  constructor(pi: ExtensionAPI) {
    this.server = http.createServer(this.handleRequest.bind(this));
    this.pi = pi;
    this.audioSegmentBuffer = {};
  }

  start(port: number) {
    if (!this.server.listening) this.server.listen(port);
  }

  close() {
    this.hub.close();
    this.server.closeAllConnections();
    this.server.close();
  }

  handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const { pathname, searchParams } = new URL(req.url, "http://localhost");
      const segmentMatch = pathname.match(/^\/segments\/(\d+)\/(\d+)\/audio$/);
      if (pathname === "/stream") this.hub.attach(req, res, searchParams.get("audio") === "1");
      else if (pathname === "/cancel") this.handleCancel(req, res);
      else if (pathname === "/submit") this.handleSubmit(req, res).catch((err) => {
        errorLog("subscriber", { submitError: String(err) });
        res.statusCode = 500;
        res.end();
      });
      else if (segmentMatch) this.audio.serve(Number(segmentMatch[1]), Number(segmentMatch[2]), res);
      else {
        res.statusCode = 404;
        res.end();
      }
    } catch (err) {
      errorLog("subscriber", { requestError: String(err) });
      res.statusCode = 500;
      res.end();
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
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
    const url = process.env.FAMILIAR_STT_URL;
    if (!url) return Promise.reject(new Error("FAMILIAR_STT_URL not set"));
    return fetch(url, { method: "POST", body: Buffer.from(data, "base64") })
      .then(async (res) => {
        if (!res.ok) throw new Error(`stt ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const { text } = await res.json();
        return typeof text === "string" ? text : "";
      });
  }

  // One retry on transcription failure; after that the segment resolves to a
  // bracketed placeholder so inference proceeds on the segments we do have.
  private transcribeWithRetry(data: string): Promise<string> {
    return this.transcribe(data)
      .catch(() => this.transcribe(data))
      .catch((err) => {
        errorLog("subscriber", { error: String(err) });
        return "[transcribed segment missing]";
      });
  }

  // Abort the in-flight turn. Idempotent fire-and-forget: aborting an idle
  // agent is a no-op, so 204 unconditionally. The interrupted assistant
  // message locks at its partial content via the existing agent_end path.
  private handleCancel(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end();
    }
    try {
      this.ctx?.abort?.();
    } catch (err) {
      errorLog("subscriber", { cancelError: String(err) });
    }
    res.statusCode = 204;
    res.end();
  }

  // correlationId: client-chosen submit id (take or text). Recorded against
  // the exact dispatched text so the firehose can attach it to pi's echo.
  private sendParts(correlationId: number | undefined, ...parts) {
    const draft = this.ctx.ui?.getEditorText?.() ?? "";
    debugLog("sendPartsDebug", { draft });
    const dispatchParts = parts
      .concat([draft])
      .map(part => typeof part === "string" ? { type: "text", text: part } : part)
      .filter(part => !!part && typeof part.text === "string" && !!part.text.trim());
    if (!dispatchParts.length) return;
    if (correlationId !== undefined) {
      // Must mirror messageText(): text parts joined with "".
      this.echoes.push(correlationId, dispatchParts.map((p) => p.text).join(""));
    }
    this.pi.sendUserMessage(dispatchParts, { deliverAs: INGRESS_DISPOSITION });
    if (draft.trim()) this.ctx.ui.setEditorText("");
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
      this.sendParts(payload.id, payload.content);
    } else {
      const { id, seq, data, segments } = payload;
      const take = this.audioSegmentBuffer[id] = this.audioSegmentBuffer[id] || {};
      if (take[seq] === undefined) {
        take[seq] = { data, transcription: this.transcribeWithRetry(data) };
      }

      if (segments > 0) {
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
              // the guidance side lives in identity.ts. payload.text is typed
              // by the client and is deliberately left unmarked.
              this.sendParts(id, `🗣 ${transcriptions.join(" ")}`, payload.text);
            })
            .catch((err) => {
              // Dispatch must never escape to uncaughtException and kill pi.
              errorLog("subscriber", { dispatchError: String(err), id });
            })
            .finally(() => { delete this.audioSegmentBuffer[id]; });
        }
      }
    }

    res.end();
  }
}
