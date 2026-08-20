// claude-driver.ts — tiamat-retirement claude driver as a pi extension.
//
// A double-loopback gateway OWNED BY THE PI EXTENSION, in-process with pi, that
// lets pi talk to Anthropic by driving the real `claude` CLI headlessly instead
// of routing through the tiamat Go service. See RESEARCH-retire-tiamat.md.
//
// v0: single-turn text chat.  v1b (this file now): multi-turn transcript
// authority + tools. Each pi request is a FRESH deterministic projection of the
// whole transcript (minus trailing user content) written into an ephemeral
// CLAUDE_CONFIG_DIR projects path; claude --resume/--session-id loads it; the
// trailing user text (or a continuation prompt after a tool result) is the
// stdin line. Pi is the sole transcript authority — no held claude process.
//
// ACTIVATION GATE: COMPLETE NO-OP unless FAMILIAR_ANTHROPIC_OAUTH is present.
// When present its value is the Anthropic subscription OAuth credential written
// into <CLAUDE_CONFIG_DIR>/.credentials.json (host schema learned by STRUCTURE,
// never value). The secret is never leaked into claude's child env.
//
// Isolation: loopback binds 127.0.0.1:0 (ephemeral port); per-instance
// CLAUDE_CONFIG_DIR + per-turn temp dirs; torn down on session_shutdown.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAnthropicBody, type AnthropicRequest } from "./lib/anthropic-body.ts";
import { runClaude, synthesizeCleanSSE, type SSEFrame } from "./lib/claude-runner.ts";
import {
  projectClaudeCodeJSONL,
  appendToolResultResumeGuard,
  messagesForProjection,
  rewriteToolNamesForProjection,
  sessionIdFromSeed,
  claudeProjectKey,
  claudeModelArg,
  CONTINUATION_PROMPT,
  type Message,
} from "./lib/claude-projection.ts";

const GATE = "FAMILIAR_ANTHROPIC_OAUTH";
const MCP_SERVER = "pi";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_STUB_PATH = path.join(HERE, "lib", "mcp-stub.ts");

export default function (pi: ExtensionAPI) {
  // ---- ACTIVATION GATE -----------------------------------------------------
  const oauthRaw = process.env[GATE];
  if (!oauthRaw || oauthRaw.trim() === "") return; // no-op; tiamat path stands

  const debug = !!process.env.FAMILIAR_CLAUDE_DRIVER_DEBUG;
  const log = (...a: unknown[]) => { if (debug) console.error("[claude-driver]", ...a); };
  const execPath = process.execPath; // node/bun running this extension — reused for the stdio stub

  let instanceRoot = "";
  let configDir = "";
  let piServer: http.Server | null = null;
  let registered = false;
  const inflight = new Set<{ abort: () => void }>();

  // ---- credential materialization (never logs token material) --------------
  function writeCredentials(dir: string): void {
    let cred: unknown;
    const trimmed = oauthRaw!.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && "claudeAiOauth" in parsed) {
        cred = parsed;
      } else if (parsed && typeof parsed === "object" && ("accessToken" in parsed || "access_token" in parsed)) {
        const p = parsed as Record<string, unknown>;
        cred = { claudeAiOauth: {
          accessToken: p.accessToken ?? p.access_token,
          refreshToken: p.refreshToken ?? p.refresh_token ?? "",
          expiresAt: p.expiresAt ?? p.expires_at ?? 0,
          scopes: p.scopes ?? ["user:inference", "user:profile"],
          subscriptionType: p.subscriptionType ?? p.subscription_type ?? "max",
        } };
      } else throw new Error("unrecognized JSON shape");
    } catch {
      cred = { claudeAiOauth: { accessToken: trimmed, refreshToken: "", expiresAt: 0, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } };
    }
    const file = path.join(dir, ".credentials.json");
    fs.writeFileSync(file, JSON.stringify(cred), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  // Write <configDir>/projects/<key>/<sessionId>.jsonl atomically (mode 0600),
  // return the path so we can remove it after the turn.
  function writeProjection(sessionId: string, workDir: string, data: string): string {
    const dir = path.join(configDir, "projects", claudeProjectKey(workDir));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, sessionId + ".jsonl");
    const tmp = path.join(dir, `.proj-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, target);
    return target;
  }

  // ---- pi-facing gateway: POST /anthropic/v1/messages ----------------------
  function handleMessages(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = parseAnthropicBody(JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicRequest);
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: String(e) } }));
        return;
      }

      const workDir = process.cwd();
      const turnTmp = fs.mkdtempSync(path.join(instanceRoot, "turn-"));
      const cleanupPaths: string[] = [turnTmp];
      const ac = new AbortController();
      const handle = { abort: () => ac.abort() };
      inflight.add(handle);

      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      const send = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      let sentAny = false;

      try {
        // Reject unsupported content explicitly rather than dropping pixels.
        for (const m of parsed.messages) {
          for (const c of m.content) {
            if (c.type === "image") {
              throw Object.assign(new Error("image content blocks are not yet supported by the local claude driver (inline base64 projection pending); refusing to silently drop pixels"), { code: "unsupported_content" });
            }
          }
        }

        // --- Projection: whole transcript minus trailing user content -------
        const toolNames = parsed.tools.map((t) => t.name).filter(Boolean);
        let projectionMessages = messagesForProjection(parsed.messages);
        projectionMessages = rewriteToolNamesForProjection(projectionMessages, toolNames, MCP_SERVER);

        // Deterministic session id from a stable seed. We key on the FIRST
        // message id (stable across a conversation's turns) so --resume reloads
        // the same session id each turn. Fallback to a per-instance id.
        const seed = firstStableSeed(parsed.messages) || instanceRoot;
        const sessionId = sessionIdFromSeed(seed);

        const useResume = projectionMessages.length > 0;
        let projectionPath = "";
        if (useResume) {
          let jsonl = projectClaudeCodeJSONL(projectionMessages, { sessionId, cwd: workDir });
          // If the leaf is a tool_result, append the soft continuation guard so
          // --resume has a user turn to answer (tiamat parity).
          jsonl = appendToolResultResumeGuard(jsonl, { sessionId, cwd: workDir }).projection;
          projectionPath = writeProjection(sessionId, workDir, jsonl);
          cleanupPaths.push(projectionPath);
        }

        // --- stdin line: trailing user text, OR continuation after tool ------
        const last = parsed.messages[parsed.messages.length - 1];
        const continuation = last && last.role === "tool";
        const trailingUserText = last && last.role === "user"
          ? last.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("")
          : "";
        const stdinContent = continuation ? CONTINUATION_PROMPT : (trailingUserText || "Continue.");

        // --- system prompt file ---------------------------------------------
        let systemPromptFile: string | undefined;
        if (parsed.system) {
          systemPromptFile = path.join(turnTmp, "system-prompt.txt");
          fs.writeFileSync(systemPromptFile, parsed.system, { mode: 0o600 });
        }

        // --- tools mode: MCP stub + capture ---------------------------------
        const hasTools = toolNames.length > 0;
        let mcpConfigFile: string | undefined;
        let capturePath: string | undefined;
        let allowedTools: string[] | undefined;
        if (hasTools) {
          capturePath = path.join(turnTmp, "capture.json");
          const mcpTools = parsed.tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.input_schema ?? { type: "object", properties: {} } }));
          mcpConfigFile = path.join(turnTmp, "mcp-config.json");
          fs.writeFileSync(mcpConfigFile, JSON.stringify({
            mcpServers: {
              [MCP_SERVER]: {
                command: execPath,
                args: [MCP_STUB_PATH],
                env: {
                  MCP_STUB_TOOLS: JSON.stringify(mcpTools),
                  MCP_STUB_CAPTURE: capturePath,
                  ...(debug ? { MCP_STUB_LOG: path.join(turnTmp, "mcp-stub.log") } : {}),
                },
              },
            },
          }));
          allowedTools = toolNames.map((n) => `mcp__${MCP_SERVER}__${n}`);
        }

        const model = claudeModelArg(parsed.model);
        log("turn", { sessionId, useResume, continuation, hasTools, stdinLen: stdinContent.length, model });

        const run = runClaude({
          stdin: continuation
            ? JSON.stringify({ type: "user", message: { role: "user", content: CONTINUATION_PROMPT }, parent_tool_use_id: null }) + "\n"
            : stdinContent,
          streamJsonInput: continuation,
          configDir,
          model,
          systemPromptFile,
          resume: useResume ? sessionId : undefined,
          sessionId: useResume ? undefined : sessionId,
          mcpConfigFile,
          allowedTools,
          cwd: workDir,
          signal: ac.signal,
        });

        if (hasTools) {
          // COLLAPSE MODE: drain claude (may be multiple messages due to
          // ToolSearch), then synthesize ONE clean pi message. The real tool
          // call is captured out-of-band by the MCP stub.
          for await (const _ of run.frames) { /* drain; collapsed below */ }
          const d = await run.done;
          let capturedTool: { id: string; name: string; input: unknown } | null = null;
          if (capturePath && fs.existsSync(capturePath)) {
            try {
              const cap = JSON.parse(fs.readFileSync(capturePath, "utf8"));
              capturedTool = { id: cap.toolUseId || ("toolu_" + Math.random().toString(36).slice(2)), name: cap.name, input: cap.arguments ?? {} };
            } catch (e) { log("capture parse err", e); }
          }
          if (d.isError && !capturedTool && !d.text) {
            send("error", { type: "error", error: { type: "api_error", message: d.errorText ?? "claude error" } });
          } else {
            for (const f of synthesizeCleanSSE(d, capturedTool)) { sentAny = true; send(f.event, f.data); }
          }
          log("turn done (tools)", { isError: d.isError, tool: capturedTool?.name, cost: d.cost });
        } else {
          // VERBATIM MODE: forward claude's SSE frames directly (nice streaming).
          for await (const frame of run.frames) { sentAny = true; send(frame.event, frame.data); }
          const d = await run.done;
          if (d.isError && !sentAny) send("error", { type: "error", error: { type: "api_error", message: d.errorText ?? "claude error" } });
          log("turn done (text)", { isError: d.isError, cost: d.cost });
        }
      } catch (e: any) {
        if (!sentAny) {
          const isUnsupported = e && e.code === "unsupported_content";
          send("error", { type: "error", error: { type: isUnsupported ? "invalid_request_error" : "api_error", message: String(e?.message ?? e) } });
        }
      } finally {
        inflight.delete(handle);
        for (const p of cleanupPaths) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
        res.end();
      }
    });
  }

  // A stable per-conversation seed: the id of the first message. Anthropic
  // bodies from pi carry synthetic ids we assign per-parse, so this is NOT
  // stable across turns yet — see NOTE below. For v1b we derive it from the
  // first user message's TEXT hash so resume keys consistently across turns.
  function firstStableSeed(messages: Message[]): string {
    const firstUser = messages.find((m) => m.role === "user");
    if (!firstUser) return "";
    const text = firstUser.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
    return text ? "conv:" + text.slice(0, 200) : "";
  }

  function startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url && req.url.replace(/\/$/, "").endsWith("/v1/messages")) { handleMessages(req, res); return; }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: req.url } }));
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => { piServer = server; resolve(); });
    });
  }

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
