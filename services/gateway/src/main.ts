import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { debugLog, errorLog } from "./debug.ts";
import { ChannelRegistry, type Channel } from "./channels.ts";
import { SessionCatalog } from "./sessions.ts";
import { PtyBridge, PtySessionError, resolvePresenceSocket } from "./pty.ts";
import { handleUpload } from "./upload.ts";
import type { IngestEnvelope, SessionIdentity } from "./protocol.ts";
import { resolveTheme, toCss, toResttyTheme, ThemeError } from "./theme/resolve.ts";
import { isLoopbackHost, requireSafeGatewayHost } from "./network.ts";

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
// Nix dev shells point this at the generated double-patched font. Installed
// packages already replace the repository base font during their build.
const PATCHED_FONT = process.env.FAMILIAR_GATEWAY_PATCHED_FONT;

const channels = new ChannelRegistry();
const sessions = new SessionCatalog(channels);
const pty = new PtyBridge();

function identityFromQuery(searchParams: URLSearchParams): SessionIdentity | undefined {
  const sessionId = searchParams.get("session");
  const role = searchParams.get("role");
  if (!sessionId || (role !== "primary" && role !== "fork")) return undefined;
  const parentSessionId = searchParams.get("parentSessionId") ?? undefined;
  if (role === "fork" && !parentSessionId) return undefined;
  return { sessionId, role, ...(parentSessionId ? { parentSessionId } : {}) };
}

function selectedChannel(searchParams: URLSearchParams, res: http.ServerResponse): Channel | undefined {
  const requested = searchParams.get("session");
  const channel = channels.get(requested);
  if (!channel) {
    res.statusCode = 404;
    res.end("unknown session");
  }
  return channel;
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
    if (pathname === "/sessions") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(sessions.list()));
    }
    if (pathname === "/health") {
      const channel = channels.primary();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, session: channel.hub.session }));
    }
    if (pathname === "/ingest") return void handleIngest(req, res);

    // The extension can register its relay before its first ingest POST. Other
    // callers only select an existing session; absent ?session always selects
    // the most recently registered primary channel.
    const relayIdentity = pathname === "/relay" ? identityFromQuery(searchParams) : undefined;
    const channel = relayIdentity ? channels.register(relayIdentity) : selectedChannel(searchParams, res);
    if (!channel) return;

    if (pathname === "/agent") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({
        session: channel.hub.session, active: channel.hub.agentActive,
        ...(channel.hub.agentAfterMessageId === undefined ? {} : {
          after_message_id: channel.hub.agentAfterMessageId,
        }),
      }));
    }
    if (pathname === "/stream") return channel.hub.attach(req, res, searchParams.get("audio") === "1");
    if (pathname === "/relay") return channel.relay.attach(req, res);
    if (pathname === "/voice-status") return void channel.ingress.handleVoiceStatus(req, res).catch((err) => {
      errorLog("subscriber", { voiceStatusError: String(err) });
      res.statusCode = 500; res.end();
    });
    if (pathname === "/submit") return void channel.ingress.handleSubmit(req, res).catch((err) => {
      errorLog("subscriber", { submitError: String(err) });
      res.statusCode = 500; res.end();
    });
    if (pathname === "/cancel") return channel.ingress.handleCancel(req, res);
    if (pathname === "/upload") return void handleUpload(req, res, searchParams,
      (message) => channel.relay.send({ type: "submit", parts: [message] })).catch((err) => {
      errorLog("subscriber", { uploadError: String(err) });
      if (!res.headersSent) { res.statusCode = 500; res.end(); }
    });
    if (seg) return channel.audio.serve(Number(seg[1]), Number(seg[2]), res);

    // Static assets for the browser terminal.
    if (pathname.startsWith("/app/")) return serveFile(res, WEB, pathname.slice("/app/".length));
    if (pathname.startsWith("/vendor/")) return serveFile(res, VENDOR, pathname.slice("/vendor/".length));
    if (pathname === "/fonts/ProggyCleanNerdFontMono-Regular.ttf" && PATCHED_FONT) {
      return serveFile(res, path.dirname(PATCHED_FONT), path.basename(PATCHED_FONT));
    }
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
    const parsed = JSON.parse(await readBody(req));
    if (!parsed || typeof parsed.kind !== "string") throw new Error("invalid ingest envelope");
    // Compatibility for pre-M4 subscribers and local smoke probes: untagged
    // envelopes retain the old meaning of "the primary channel".
    const tagged = parsed.sessionId !== undefined || parsed.role !== undefined;
    if (tagged && !(typeof parsed.sessionId === "string" && parsed.sessionId
      && (parsed.role === "primary" || parsed.role === "fork")
      && (parsed.role !== "fork" || (typeof parsed.parentSessionId === "string" && parsed.parentSessionId)))) {
      throw new Error("invalid session identity");
    }
    const env = tagged ? parsed as IngestEnvelope
      : { ...parsed, sessionId: channels.primary().id, role: "primary" } as IngestEnvelope;
    channels.ingest(env).apply(env);
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
  const { pathname, searchParams } = new URL(req.url ?? "/", "http://localhost");
  if (pathname !== "/pty") return socket.destroy();
  try {
    const requested = searchParams.get("session") ?? undefined;
    const channel = requested ? channels.get(requested) : channels.primary();
    // Unknown explicit ids are treated as fork ids so the filesystem resolver
    // can attach stopped/discovered forks and reject malformed or absent ones.
    const role = channel?.role ?? "fork";
    const presenceSocket = resolvePresenceSocket(requested, role);
    pty.handleUpgrade(req, socket, head, presenceSocket);
  } catch (err) {
    const status = err instanceof PtySessionError ? err.statusCode : 500;
    socket.write(`HTTP/1.1 ${status} ${status === 400 ? "Bad Request" : "Not Found"}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }
});
server.on("error", (err) => errorLog("subscriber", { serverError: String(err) }));

const PORT = Number(process.env.FAMILIAR_SERVER_PORT ?? process.env.FAMILIAR_SUBSCRIBER_PORT ?? 1692);
const HOST = process.env.FAMILIAR_SERVER_HOST ?? "127.0.0.1";
const ALLOW_NONLOOPBACK = process.env.FAMILIAR_GATEWAY_ALLOW_NONLOOPBACK === "1";
try {
  requireSafeGatewayHost(HOST, ALLOW_NONLOOPBACK);
} catch (error) {
  process.stderr.write(`familiar gateway security error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
if (!isLoopbackHost(HOST)) {
  process.stderr.write(`*** FAMILIAR GATEWAY SECURITY WARNING: unauthenticated routes are exposed on non-loopback host ${HOST} ***\n`);
}
server.listen(PORT, HOST, () => {
  debugLog("subscriber", { serverUp: `${HOST}:${PORT}` });
  process.stderr.write(`familiar server listening on http://${HOST}:${PORT}\n`);
});

function shutdown() {
  channels.close();
  pty.close();
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
