// loopback-b.test.ts — focused integration tests for the claude-facing gateway
// (LOOPBACK B). NO real secrets, NO api.anthropic.com: a fake upstream HTTP
// server stands in for Anthropic and records exactly what the handler forwarded.
// Covers: header preservation (incl. auth), transformed body (cache hygiene),
// response streaming, upstream errors, ratelimit propagation, and two-server
// ephemeral isolation.
//
// Run: nix develop .#stt -c bun test extensions/lib/loopback-b.test.ts
import { expect, test, describe } from "bun:test";
import * as http from "node:http";
import { createClaudeFacingHandler } from "./loopback-b.ts";

interface Captured {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// A fake "api.anthropic.com": records the inbound request, then replies with a
// scripted status/headers/body. Streams the body in two chunks to exercise the
// pipe path.
function startFakeUpstream(script: {
  status: number;
  headers: Record<string, string>;
  bodyChunks: string[];
  onRequest?: (c: Captured) => void;
}): Promise<{ base: string; close: () => Promise<void>; last: () => Captured | null }> {
  let last: Captured | null = null;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        last = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
        script.onRequest?.(last);
        res.writeHead(script.status, script.headers);
        // stream chunks with a micro delay so pipe genuinely streams
        let i = 0;
        const pump = () => {
          if (i < script.bodyChunks.length) { res.write(script.bodyChunks[i++]); setTimeout(pump, 2); }
          else res.end();
        };
        pump();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        last: () => last,
      });
    });
  });
}

// Start a loopback-B server wrapping the handler, and give back a client.
function startLoopbackB(opts: {
  upstreamBase: string;
  onRatelimit?: (turnId: string, headers: Record<string, string>) => void;
  maxBodyBytes?: number;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const handler = createClaudeFacingHandler({
    upstreamBase: opts.upstreamBase,
    onRatelimit: opts.onRatelimit ?? (() => {}),
    maxBodyBytes: opts.maxBodyBytes,
  });
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res));
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as any).port, close: () => new Promise<void>((r) => server.close(() => r())) }));
  });
}

function post(port: number, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

describe("loopback B — claude-facing gateway", () => {
  test("preserves claude's OWN auth/client headers upstream (no substitution)", async () => {
    const up = await startFakeUpstream({ status: 200, headers: { "content-type": "application/json" }, bodyChunks: ['{"ok":true}'] });
    const lb = await startLoopbackB({ upstreamBase: up.base });
    // Fake — clearly not a real token.
    const clientHeaders = {
      "content-type": "application/json",
      authorization: "Bearer sk-ant-oat-FAKE-TEST-TOKEN",
      "anthropic-beta": "oauth-2025-04-20",
      "x-app": "cli",
      "user-agent": "claude-cli/2.1.197",
      "anthropic-version": "2023-06-01",
    };
    await post(lb.port, "/turn/t-abc/v1/messages", clientHeaders, JSON.stringify({ model: "x", messages: [] }));
    const seen = up.last()!;
    expect(seen.headers["authorization"]).toBe("Bearer sk-ant-oat-FAKE-TEST-TOKEN");
    expect(seen.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(seen.headers["x-app"]).toBe("cli");
    expect(seen.headers["user-agent"]).toBe("claude-cli/2.1.197");
    // Path had the /turn/<id> prefix stripped before forwarding.
    expect(seen.url).toBe("/v1/messages");
    // Hop-by-hop / host recomputed, not blindly forwarded.
    expect(seen.headers["host"]).toContain("127.0.0.1");
    await lb.close(); await up.close();
  });

  test("applies cache hygiene to the transformed body (strips the artifact tail)", async () => {
    const up = await startFakeUpstream({ status: 200, headers: {}, bodyChunks: ["{}"] });
    const lb = await startLoopbackB({ upstreamBase: up.base });
    // A body with the real 2.1.197 continuation artifact tail: assistant
    // "No response requested." + user "<tool-result>…</tool-result>" after a
    // tool_result. applyCacheHygiene must relocate + strip those two messages.
    const dirty = {
      model: "claude-x",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__pi__x", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result" }] },
        { role: "assistant", content: [{ type: "text", text: "No response requested." }] },
        { role: "user", content: [{ type: "text", text: "<tool-result>Tool call complete. Results are above.</tool-result>", cache_control: { type: "ephemeral" } }] },
      ],
    };
    await post(lb.port, "/turn/t-1/v1/messages", { "content-type": "application/json" }, JSON.stringify(dirty));
    const fwd = JSON.parse(up.last()!.body);
    // The trailing assistant/continuation pair is gone.
    expect(fwd.messages.length).toBe(3);
    const last = fwd.messages[fwd.messages.length - 1];
    expect(last.content[0].type).toBe("tool_result");
    // The relocated breakpoint now anchors the tool_result (stable prefix).
    expect(last.content[0].cache_control).toEqual({ type: "ephemeral" });
    // content-length recomputed to match the (shorter) transformed body.
    expect(Number(up.last()!.headers["content-length"])).toBe(Buffer.byteLength(up.last()!.body));
    await lb.close(); await up.close();
  });

  test("forwards a non-messages body UNCHANGED (no hygiene on count_tokens)", async () => {
    const up = await startFakeUpstream({ status: 200, headers: {}, bodyChunks: ["{}"] });
    const lb = await startLoopbackB({ upstreamBase: up.base });
    const raw = JSON.stringify({ anything: "verbatim", messages: [{ role: "assistant", content: [{ type: "text", text: "No response requested." }] }] });
    await post(lb.port, "/turn/t-2/v1/messages/count_tokens", { "content-type": "application/json" }, raw);
    expect(up.last()!.body).toBe(raw);
    await lb.close(); await up.close();
  });

  test("streams the upstream response back verbatim (status, headers, multi-chunk body)", async () => {
    const up = await startFakeUpstream({
      status: 200,
      headers: { "content-type": "text/event-stream", "x-custom": "kept" },
      bodyChunks: ["event: message_start\ndata: {}\n\n", "event: message_stop\ndata: {}\n\n"],
    });
    const lb = await startLoopbackB({ upstreamBase: up.base });
    const resp = await post(lb.port, "/turn/t-3/v1/messages", { "content-type": "application/json" }, JSON.stringify({ messages: [] }));
    expect(resp.status).toBe(200);
    expect(resp.headers["content-type"]).toBe("text/event-stream");
    expect(resp.headers["x-custom"]).toBe("kept");
    expect(resp.body).toBe("event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n");
    await lb.close(); await up.close();
  });

  test("captures + propagates per-turn ratelimit headers (keyed by turnId)", async () => {
    const up = await startFakeUpstream({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.12",
        "anthropic-ratelimit-unified-7d-utilization": "0.44",
        "request-id": "req_FAKE123",
      },
      bodyChunks: ["data: {}\n\n"],
    });
    const captured: Record<string, Record<string, string>> = {};
    const lb = await startLoopbackB({ upstreamBase: up.base, onRatelimit: (id, h) => { captured[id] = h; } });
    await post(lb.port, "/turn/t-ABC/v1/messages", { "content-type": "application/json" }, JSON.stringify({ messages: [] }));
    expect(captured["t-ABC"]).toBeDefined();
    expect(captured["t-ABC"]["anthropic-ratelimit-unified-status"]).toBe("allowed");
    expect(captured["t-ABC"]["anthropic-ratelimit-unified-5h-utilization"]).toBe("0.12");
    expect(captured["t-ABC"]["anthropic-ratelimit-unified-7d-utilization"]).toBe("0.44");
    expect(captured["t-ABC"]["request-id"]).toBe("req_FAKE123");
    await lb.close(); await up.close();
  });

  test("propagates retry-after on a 429 upstream + relays status", async () => {
    const up = await startFakeUpstream({
      status: 429,
      headers: { "retry-after": "17", "anthropic-ratelimit-unified-status": "rejected" },
      bodyChunks: ['{"type":"error"}'],
    });
    const captured: Record<string, Record<string, string>> = {};
    const lb = await startLoopbackB({ upstreamBase: up.base, onRatelimit: (id, h) => { captured[id] = h; } });
    const resp = await post(lb.port, "/turn/t-429/v1/messages", { "content-type": "application/json" }, JSON.stringify({ messages: [] }));
    expect(resp.status).toBe(429);
    expect(captured["t-429"]["retry-after"]).toBe("17");
    expect(captured["t-429"]["anthropic-ratelimit-unified-status"]).toBe("rejected");
    await lb.close(); await up.close();
  });

  test("returns 502 on an unreachable upstream (dead port), does not hang", async () => {
    // Point at a port nothing listens on.
    const lb = await startLoopbackB({ upstreamBase: "http://127.0.0.1:1" });
    const resp = await post(lb.port, "/turn/t-err/v1/messages", { "content-type": "application/json" }, JSON.stringify({ messages: [] }));
    expect(resp.status).toBe(502);
    expect(resp.body).toContain("upstream error");
    await lb.close();
  });

  test("rejects an oversized body with 413 (size guard)", async () => {
    const up = await startFakeUpstream({ status: 200, headers: {}, bodyChunks: ["{}"] });
    const lb = await startLoopbackB({ upstreamBase: up.base, maxBodyBytes: 1024 });
    const big = "x".repeat(4096);
    const resp = await post(lb.port, "/turn/t-big/v1/messages", { "content-type": "application/json" }, JSON.stringify({ blob: big }));
    expect(resp.status).toBe(413);
    // Upstream must NOT have received the oversized request.
    expect(up.last()).toBeNull();
    await lb.close(); await up.close();
  });

  test("two loopback-B servers bind DISTINCT ephemeral ports (isolation)", async () => {
    const up = await startFakeUpstream({ status: 200, headers: {}, bodyChunks: ["{}"] });
    const a = await startLoopbackB({ upstreamBase: up.base });
    const b = await startLoopbackB({ upstreamBase: up.base });
    expect(a.port).not.toBe(b.port);
    await a.close(); await b.close(); await up.close();
  });
});
