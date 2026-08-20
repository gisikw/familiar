import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { debugLog, errorLog } from "./debug.ts";
import { StreamHub } from "./hub.ts";
import { AudioCache } from "./audio.ts";
import { RelayBus } from "./relay.ts";
import { Ingress } from "./ingress.ts";
import { PtyBridge } from "./pty.ts";
import { handleUpload } from "./upload.ts";
import type { IngestEnvelope } from "./protocol.ts";
import { resolveTheme, toCss, toResttyTheme, ThemeError } from "./theme/resolve.ts";

/* --- theme: resolved once at boot from FAMILIAR_THEME_* env (defaults live in
 * theme/defaults.json). A bad color fails the server loudly rather than
 * silently serving a broken page. Cold restart re-reads env -> new theme, no
 * asset rebuild. */
let THEME_CSS: string;
let THEME_JSON: string;
try {
  const theme = resolveTheme();
  THEME_CSS = toCss(theme);
  THEME_JSON = JSON.stringify(toResttyTheme(theme));
} catch (err) {
  if (err instanceof ThemeError) {
    process.stderr.write(`familiar theme error: ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}

/* --- Familiar server: the web presence -------------------------------------
 *
 * Binds 127.0.0.1:1692. Owns all HTTP that used to live in the subscriber
 * extension (SSE hub, ingress, segment audio) plus the new /ingest egress
 * endpoint and the browser terminal. No auth — localhost only.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "web");
const VENDOR = path.join(ROOT, "vendor");
const FONTS = path.join(ROOT, "fonts");

const hub = new StreamHub();
const audio = new AudioCache(hub);
const relay = new RelayBus();
const ingress = new Ingress(relay);
const pty = new PtyBridge();

/* --- /ingest: apply an egress envelope from the extension ------------------ */
function applyIngest(env: IngestEnvelope) {
  switch (env.kind) {
    case "session":
      hub.newSession();
      return;
    case "lock":
      hub.lockInflight();
      return;
    case "revise":
      hub.revise(env.event);
      return;
    case "publish": {
      const event = env.event;
      // Segment events drive server-side synthesis: the server owns the audio
      // listener registry, so it (not the extension) decides `synthesizing`.
      if (event.event === "segment") {
        const synth = hub.anyAudioListener();
        audio.register(event.message_id, event.index, event.text, synth);
        hub.publish({ ...event, synthesizing: synth });
      } else {
        hub.publish(event);
      }
      return;
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/* --- static files ---------------------------------------------------------- */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

function serveFile(res: http.ServerResponse, base: string, rel: string) {
  // Contain within base — reject traversal.
  const full = path.join(base, rel);
  if (!full.startsWith(base + path.sep) && full !== base) {
    res.statusCode = 403;
    return res.end();
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.statusCode = 404;
      return res.end();
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream" });
    res.end(data);
  });
}

/* --- request router -------------------------------------------------------- */
function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const { pathname, searchParams } = new URL(req.url ?? "/", "http://localhost");
    const seg = pathname.match(/^\/segments\/(\d+)\/(\d+)\/audio$/);

    if (pathname === "/" || pathname === "/terminal") return serveFile(res, WEB, "terminal.html");
    if (pathname === "/theme.css") { res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" }); return res.end(THEME_CSS); }
    if (pathname === "/theme.json") { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" }); return res.end(THEME_JSON); }
    if (pathname === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, session: hub.session })); }
    if (pathname === "/stream") return hub.attach(req, res, searchParams.get("audio") === "1");
    if (pathname === "/relay") return relay.attach(req, res);
    if (pathname === "/submit") return void ingress.handleSubmit(req, res).catch((err) => {
      errorLog("subscriber", { submitError: String(err) });
      res.statusCode = 500; res.end();
    });
    if (pathname === "/cancel") return ingress.handleCancel(req, res);
    if (pathname === "/ingest") return void handleIngest(req, res);
    if (pathname === "/upload") return void handleUpload(req, res, searchParams).catch((err) => {
      errorLog("subscriber", { uploadError: String(err) });
      if (!res.headersSent) { res.statusCode = 500; res.end(); }
    });
    if (seg) return audio.serve(Number(seg[1]), Number(seg[2]), res);

    // Static assets for the browser terminal.
    if (pathname.startsWith("/app/")) return serveFile(res, WEB, pathname.slice("/app/".length));
    if (pathname.startsWith("/vendor/")) return serveFile(res, VENDOR, pathname.slice("/vendor/".length));
    if (pathname.startsWith("/fonts/")) return serveFile(res, FONTS, pathname.slice("/fonts/".length));

    res.statusCode = 404;
    res.end();
  } catch (err) {
    errorLog("subscriber", { requestError: String(err) });
    res.statusCode = 500;
    res.end();
  }
}

async function handleIngest(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
  try {
    const env = JSON.parse(await readBody(req)) as IngestEnvelope;
    applyIngest(env);
    res.statusCode = 204;
    res.end();
  } catch (err) {
    errorLog("subscriber", { ingestError: String(err) });
    res.statusCode = 400;
    res.end();
  }
}

const server = http.createServer(handle);
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/pty") pty.handleUpgrade(req, socket, head);
  else socket.destroy();
});
server.on("error", (err) => errorLog("subscriber", { serverError: String(err) }));

const PORT = Number(process.env.FAMILIAR_SERVER_PORT ?? process.env.FAMILIAR_SUBSCRIBER_PORT ?? 1692);
const HOST = process.env.FAMILIAR_SERVER_HOST ?? "127.0.0.1";
server.listen(PORT, HOST, () => {
  debugLog("subscriber", { serverUp: `${HOST}:${PORT}` });
  process.stderr.write(`familiar server listening on http://${HOST}:${PORT}\n`);
});

function shutdown() {
  hub.close();
  relay.close();
  pty.close();
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
