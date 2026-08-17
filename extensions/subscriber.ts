import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import http from "http";
import fs from "fs";

type SubmitPayload =
  | { type: "text"; content: string }
  | { type: "audio"; id: number; seq: number; data: string; segments?: number; text?: string };

const INGRESS_DISPOSITION = "steer";

class SubscriberManager {
  private server: http.Server;
  private pi: ExtensionAPI;
  private audioSegmentBuffer; // TODO: type?
  public ctx: ExtensionContext;

  constructor(pi: ExtensionAPI) {
    this.server = http.createServer(this.handleRequest.bind(this));
    this.pi = pi;
    this.audioSegmentBuffer = {};
  }

  start(port: number) {
    if (!this.server.listening) this.server.listen(port);
  }

  close() {
    this.server.closeAllConnections();
    this.server.close();
  }

  handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/stream") this.handleStream(req, res);
    else if (pathname === "/submit") this.handleSubmit(req, res);
    else {
      res.statusCode = 404;
      res.end();
    }
  }

  handleStream(_req: http.IncomingMessage, res: http.ServerResponse) {
    res.write("Definitely gonna handle stream");
    res.end();
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
        fs.appendFile(`${process.env.FAMILIAR_LOG_PATH}.subscriber`, `${JSON.stringify({ error: String(err) })} \n`, 'utf8', () => { });
        return "[transcribed segment missing]";
      });
  }

  private sendParts(...parts) {
    const draft = this.ctx.ui?.getEditorText?.() ?? "";
    fs.appendFile(`${process.env.FAMILIAR_LOG_PATH}.sendPartsDebug`, `${JSON.stringify({ draft })} \n`, 'utf8', () => { });
    const dispatchParts = parts
      .concat([draft])
      .map(part => typeof part === "string" ? { type: "text", text: part } : part)
      .filter(part => !!part && typeof part.text === "string" && !!part.text.trim());
    if (!dispatchParts.length) return;
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
      this.sendParts(payload.content);
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
              this.sendParts(transcriptions.join(" "), payload.text);
            })
            .catch((err) => {
              // Dispatch must never escape to uncaughtException and kill pi.
              fs.appendFile(`${process.env.FAMILIAR_LOG_PATH}.subscriber`, `${JSON.stringify({ dispatchError: String(err), id })} \n`, 'utf8', () => { });
            })
            .finally(() => { delete this.audioSegmentBuffer[id]; });
        }
      }
    }

    res.end();
  }
}

class EventCache {
  private messages = {};
  private messageId = 1;
  private responseId;
  private revisionId = 1;

  private segments = {};
  private segmentId = 1;

  handleMessageUpdate({ assistantMessageEvent }, ctx) {
    const eventType = assistantMessageEvent.type;

    if (eventType != "text_start" && eventType != "text_delta" && eventType != "text_end")
      return;

    this.messages[this.messageId] = assistantMessageEvent.partial.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");

    const output = {
      id: `${this.messageId}${eventType === "text_end" ? "" : `:${this.revisionId++}`}`,
      event: "message",
      content: this.messages[this.messageId]
    };

    fs.appendFile(`${process.env.FAMILIAR_LOG_PATH}.output`, `${JSON.stringify(output)} \n`, 'utf8', () => { });

    if (eventType === "text_end") {
      this.messageId++;
      this.revisionId = 1;
    }
  }
}

export default function(pi: ExtensionAPI) {
  const manager = new SubscriberManager(pi);
  const eventCache = new EventCache();
  pi.on("session_start", async (_event, ctx) => {
    manager.start(Number(process.env.FAMILIAR_SUBSCRIBER_PORT ?? 1692));
    manager.ctx = ctx; // Should manager.ctx be a Promise that we resolve here?
  });
  pi.on("session_shutdown", async () => { manager.close(); });
  pi.on("message_update", async (event, ctx) => { eventCache.handleMessageUpdate(event, ctx) });
  // pi.on("message_end", async (event, ctx) => { eventCache.handleMessage(event, ctx) });
}
