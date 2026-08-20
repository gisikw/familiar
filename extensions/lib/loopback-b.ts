// loopback-b.ts — the claude-facing gateway (LOOPBACK B) request handler,
// factored out of claude-driver.ts so it is directly testable against a fake
// upstream (no real secrets, no api.anthropic.com). Behavior is IDENTICAL to
// the inlined version it replaces.
//
// claude's ANTHROPIC_BASE_URL points at http://127.0.0.1:<portB>/turn/<id>.
// We: (1) recover the per-turn id from the path, (2) apply cache/continuation
// wire hygiene to claude's outbound POST /v1/messages body (prompt-cache
// economics), (3) forward to the upstream base preserving claude's OWN
// headers/auth intact (subscription billing classification), (4) capture the
// upstream ratelimit headers for that turn, (5) stream the response back
// verbatim. NOT a control surface: no auth substitution, no capability spoof.
import type * as http from "node:http";
import * as https from "node:https";
import * as nodeHttp from "node:http";
import { applyCacheHygiene } from "./claude-cache-hygiene.ts";
import { selectRatelimitHeaders } from "./ratelimit-headers.ts";

export interface ClaudeFacingDeps {
  // Upstream base, no trailing slash (e.g. https://api.anthropic.com, or a fake
  // http://127.0.0.1:<port> in tests).
  upstreamBase: string;
  // Called with the per-turn ratelimit headers pulled off the REAL upstream
  // response, keyed by the turnId embedded in the request path. The driver
  // stores these and re-emits them on loopback A's response for the footer.
  onRatelimit: (turnId: string, headers: Record<string, string>) => void;
  log?: (...a: unknown[]) => void;
  // Cap on the buffered outbound body (defense-in-depth). Default 32 MiB.
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 32 * 1024 * 1024;

export function createClaudeFacingHandler(deps: ClaudeFacingDeps) {
  const log = deps.log ?? (() => {});
  const upstreamBase = deps.upstreamBase.replace(/\/$/, "");
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY;

  return function handleClaudeFacing(req: http.IncomingMessage, res: http.ServerResponse): void {
    let rawPath = req.url || "";
    let turnId = "";
    const m = /^\/turn\/([^/]+)(\/.*)$/.exec(rawPath);
    if (m) { turnId = m[1]; rawPath = m[2]; }

    const chunks: Buffer[] = [];
    let total = 0;
    let overflowed = false;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBody) {
        if (!overflowed) {
          overflowed = true;
          log("loopbackB body too large", { turnId, total });
          if (!res.headersSent) res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "request body too large" } }));
          req.destroy();
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (overflowed) return;
      let body = Buffer.concat(chunks);
      // Apply cache/continuation hygiene only to the messages POST.
      const isMessages = req.method === "POST" && rawPath.replace(/\?.*$/, "").endsWith("/v1/messages") && !rawPath.includes("count_tokens");
      if (isMessages && body.length) {
        try {
          const hy = applyCacheHygiene(body.toString("utf8"));
          if (hy.cacheRewrites || hy.strips) {
            body = Buffer.from(hy.body, "utf8");
            log("loopbackB hygiene", { turnId, cacheRewrites: hy.cacheRewrites, strips: hy.strips });
          }
        } catch (e) { log("loopbackB hygiene err", String(e)); /* forward original body */ }
      }

      // Forward upstream preserving claude's OWN headers (auth intact). Only
      // drop hop-by-hop / length headers we must recompute.
      const upstream = new URL(upstreamBase + rawPath);
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (lk === "host" || lk === "content-length" || lk === "connection" || lk === "accept-encoding") continue;
        if (v !== undefined) headers[k] = v as string | string[];
      }
      headers["content-length"] = String(body.length);
      if (!headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01";

      const isHttps = upstream.protocol === "https:";
      const agent = isHttps ? https : nodeHttp;
      const upReq = agent.request(
        { hostname: upstream.hostname, port: upstream.port || (isHttps ? 443 : 80), path: upstream.pathname + upstream.search, method: req.method, headers },
        (upRes) => {
          // Capture per-turn upstream ratelimit headers BEFORE body streams.
          if (turnId) {
            const rl = selectRatelimitHeaders(upRes.headers as Record<string, string | string[]>);
            if (Object.keys(rl).length) deps.onRatelimit(turnId, rl);
          }
          // Relay status + headers + body verbatim.
          res.writeHead(upRes.statusCode || 502, upRes.headers as http.OutgoingHttpHeaders);
          upRes.pipe(res);
        },
      );
      upReq.on("error", (e) => {
        log("loopbackB upstream error", String(e));
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream error: " + String(e) } }));
      });
      upReq.write(body);
      upReq.end();
    });
  };
}
