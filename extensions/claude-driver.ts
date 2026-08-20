// claude-driver.ts — tiamat-retirement claude driver as a pi extension.
//
// A double-loopback gateway OWNED BY THE PI EXTENSION, in-process with pi, that
// lets pi talk to Anthropic by driving the real `claude` CLI headlessly instead
// of routing through the tiamat Go service. See RESEARCH-retire-tiamat.md for
// the full design; this file implements v0 (single-turn text chat) plus the
// scaffolding hooks for v1.
//
// ACTIVATION GATE: the extension is a COMPLETE NO-OP unless the env var
// FAMILIAR_ANTHROPIC_OAUTH is present. When absent, pi's existing tiamat path
// (extensions/anthropic-gateway.ts) is untouched. When present, its value is the
// Anthropic subscription OAuth credential written into the per-instance
// ephemeral CLAUDE_CONFIG_DIR/.credentials.json in the schema the claude CLI
// expects (learned by inspecting the STRUCTURE — not the values — of
// ~/.claude/.credentials.json on this host: {"claudeAiOauth":{accessToken,
// refreshToken,expiresAt,scopes,subscriptionType,...}}).
//
// Isolation: every loopback binds 127.0.0.1:0 (ephemeral port) so multiple pi
// instances / dispatch subagents coexist on one host. Per-turn temp dirs,
// per-instance CLAUDE_CONFIG_DIR. Everything torn down on session_shutdown.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseAnthropicBody, type AnthropicRequest } from "./lib/anthropic-body.ts";
import { runClaude } from "./lib/claude-runner.ts";

const GATE = "FAMILIAR_ANTHROPIC_OAUTH";

export default function (pi: ExtensionAPI) {
  // ---- ACTIVATION GATE -----------------------------------------------------
  const oauthRaw = process.env[GATE];
  if (!oauthRaw || oauthRaw.trim() === "") {
    // Complete no-op: existing tiamat behavior via anthropic-gateway.ts stands.
    return;
  }

  const debug = !!process.env.FAMILIAR_CLAUDE_DRIVER_DEBUG;
  const log = (...a: unknown[]) => { if (debug) console.error("[claude-driver]", ...a); };

  // Per-instance state.
  let instanceRoot = "";
  let configDir = "";
  let piServer: http.Server | null = null;
  let registered = false;
  const inflight = new Set<{ abort: () => void }>();

  // ---- credential materialization ------------------------------------------
  // Write FAMILIAR_ANTHROPIC_OAUTH into <configDir>/.credentials.json. Accept
  // either the full {"claudeAiOauth":{...}} envelope or a bare inner object /
  // raw access token; normalize to the CLI's schema. NEVER log token material.
  function writeCredentials(dir: string): void {
    let cred: unknown;
    const trimmed = oauthRaw!.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && "claudeAiOauth" in parsed) {
        cred = parsed;
      } else if (parsed && typeof parsed === "object" && ("accessToken" in parsed || "access_token" in parsed)) {
        const p = parsed as Record<string, unknown>;
        cred = {
          claudeAiOauth: {
            accessToken: p.accessToken ?? p.access_token,
            refreshToken: p.refreshToken ?? p.refresh_token ?? "",
            expiresAt: p.expiresAt ?? p.expires_at ?? 0,
            scopes: p.scopes ?? ["user:inference", "user:profile"],
            subscriptionType: p.subscriptionType ?? p.subscription_type ?? "max",
          },
        };
      } else {
        throw new Error("unrecognized JSON shape");
      }
    } catch {
      // Not JSON: treat as a bare access token.
      cred = {
        claudeAiOauth: {
          accessToken: trimmed,
          refreshToken: "",
          expiresAt: 0,
          scopes: ["user:inference", "user:profile"],
          subscriptionType: "max",
        },
      };
    }
    const file = path.join(dir, ".credentials.json");
    fs.writeFileSync(file, JSON.stringify(cred), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  // ---- pi-facing gateway: POST /anthropic/v1/messages ----------------------
  function handleMessages(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let parsed;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicRequest;
        parsed = parseAnthropicBody(body);
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: String(e) } }));
        return;
      }

      // v0: last user text becomes the stdin prompt. (v1 projects the full
      // transcript minus the trailing user message; see RESEARCH §3.1.)
      const lastUser = [...parsed.messages].reverse().find((m) => m.role === "user");
      const prompt = lastUser?.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("") ?? "";

      // Per-turn system prompt file (optional).
      let systemPromptFile: string | undefined;
      if (parsed.system) {
        systemPromptFile = path.join(instanceRoot, `sys-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
        fs.writeFileSync(systemPromptFile, parsed.system);
      }

      const ac = new AbortController();
      const handle = { abort: () => ac.abort() };
      inflight.add(handle);

      const model = mapModel(parsed.model);
      log("turn start", { model, promptLen: prompt.length });

      const run = runClaude({
        prompt,
        configDir,
        model,
        systemPromptFile,
        cwd: process.cwd(),
        signal: ac.signal,
      });

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      let sentAny = false;
      try {
        for await (const frame of run.frames) {
          sentAny = true;
          send(frame.event, frame.data);
        }
        const fin = await run.done;
        if (fin.isError && !sentAny) {
          // No SSE emitted at all: surface an Anthropic error frame.
          send("error", { type: "error", error: { type: "api_error", message: fin.errorText ?? "claude error" } });
        }
        if (systemPromptFile) { try { fs.unlinkSync(systemPromptFile); } catch {} }
        log("turn done", { isError: fin.isError, cost: fin.cost });
      } catch (e) {
        if (!sentAny) send("error", { type: "error", error: { type: "api_error", message: String(e) } });
      } finally {
        inflight.delete(handle);
        res.end();
      }
    });
  }

  // Map pi's model id → claude --model arg. Kept minimal for v0; extend as a
  // routing map in v1 (RESEARCH §4 model steering).
  function mapModel(model: string | undefined): string | undefined {
    if (!model) return undefined;
    // pi may send "claude-opus-4-8" etc.; claude CLI accepts those directly.
    return model;
  }

  function startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url && req.url.replace(/\/$/, "").endsWith("/v1/messages")) {
          handleMessages(req, res);
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: req.url } }));
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        piServer = server;
        resolve();
      });
    });
  }

  // ---- async factory: bind port + register provider BEFORE startup ---------
  // Returning a Promise makes pi await this before session_start / provider
  // flush, so the resolved baseUrl is live when pi first uses it.
  const ready = (async () => {
    instanceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-driver-"));
    configDir = path.join(instanceRoot, "claude-config");
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeCredentials(configDir);

    await startServer();
    const addr = piServer!.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}/anthropic`;
    pi.registerProvider("anthropic", { baseUrl });
    registered = true;
    log("registered anthropic provider", { baseUrl, configDir });
  })();

  // ---- teardown ------------------------------------------------------------
  pi.on("session_shutdown", async () => {
    for (const h of inflight) { try { h.abort(); } catch {} }
    inflight.clear();
    if (registered) { try { pi.unregisterProvider("anthropic"); } catch {} registered = false; }
    if (piServer) { try { piServer.close(); } catch {} piServer = null; }
    if (instanceRoot) { try { fs.rmSync(instanceRoot, { recursive: true, force: true }); } catch {} instanceRoot = ""; }
    log("shutdown complete");
  });

  return ready;
}
