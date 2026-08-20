// claude-runner.ts — spawn a single-shot headless `claude -p` and translate its
// stream-json stdout into Anthropic Messages SSE.
//
// TWO MODES:
//  • verbatim  (no tools): with --include-partial-messages, claude emits
//    {"type":"stream_event","event":{…}} lines whose .event is VERBATIM
//    Anthropic SSE. A text-only turn is a single message, so we forward those
//    frames straight through (nice token-by-token streaming). Verified E2E.
//  • collapse  (tools present): claude 2.1.197 discovers MCP tools via an
//    internal ToolSearch meta-tool, which emits EXTRA assistant messages
//    (thinking + ToolSearch tool_use) before the real mcp__pi__* call. Pi needs
//    exactly ONE Anthropic message per request, so we DROP thinking/ToolSearch/
//    builtin noise, accumulate user-facing text, and let the caller synthesize
//    one clean message. The real tool call is captured out-of-band by the MCP
//    stub (CAPTURE file) — see mcp-stub.ts.
//
// Env hygiene: inherited ANTHROPIC_* (pi's tiamat routing) MUST be scrubbed or
// claude 400s. We also NEVER leak FAMILIAR_ANTHROPIC_OAUTH into the child
// (materialized only into CLAUDE_CONFIG_DIR/.credentials.json).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface RunnerOptions {
  stdin: string; // full stdin content (verbatim text prompt OR stream-json line)
  streamJsonInput?: boolean; // use --input-format stream-json (stdin is a JSON line)
  configDir: string; // CLAUDE_CONFIG_DIR (ephemeral, holds .credentials.json)
  claudeBaseUrl?: string; // claude's ANTHROPIC_BASE_URL → loopback B (optional)
  model?: string;
  systemPromptFile?: string;
  sessionId?: string; // --session-id (fresh)
  resume?: string; // --resume <id>
  mcpConfigFile?: string;
  allowedTools?: string[];
  settingsFile?: string;
  cwd?: string;
  signal?: AbortSignal;
  claudePath?: string;
}

export interface SSEFrame {
  event: string;
  data: unknown;
}

export interface RunResult {
  frames: AsyncIterable<SSEFrame>; // verbatim event stream (all frames)
  done: Promise<RunDone>;
}

export interface RunDone {
  isError: boolean;
  errorText?: string;
  usage?: any; // authoritative usage from the result line
  cost?: number;
  // collapse aids:
  text: string; // accumulated user-facing text_delta across all messages
  finalMessageId?: string;
  model?: string;
  stopReason?: string; // stop_reason of the LAST message
}

export function buildArgs(o: RunnerOptions): string[] {
  const args = ["-p"];
  if (o.resume) args.push("--resume", o.resume);
  else if (o.sessionId) args.push("--session-id", o.sessionId);
  if (o.systemPromptFile) args.push("--system-prompt-file", o.systemPromptFile);
  if (o.streamJsonInput) args.push("--input-format", "stream-json");
  args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose", "--permission-mode", "default");
  if (o.settingsFile) args.push("--settings", o.settingsFile);
  if (o.mcpConfigFile) args.push("--strict-mcp-config", "--mcp-config", o.mcpConfigFile);
  if (o.model) args.push("--model", o.model);
  if (o.allowedTools && o.allowedTools.length) args.push("--allowedTools=" + o.allowedTools.join(","));
  return args;
}

export function buildEnv(o: RunnerOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("ANTHROPIC_")) continue; // scrub inherited tiamat routing
    if (k === "FAMILIAR_ANTHROPIC_OAUTH") continue; // never leak the secret source
    env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = o.configDir;
  if (o.claudeBaseUrl) env.ANTHROPIC_BASE_URL = o.claudeBaseUrl;
  return env;
}

export function runClaude(o: RunnerOptions): RunResult {
  const args = buildArgs(o);
  const child: ChildProcessWithoutNullStreams = spawn(o.claudePath ?? "claude", args, {
    env: buildEnv(o),
    cwd: o.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  if (o.signal) {
    if (o.signal.aborted) child.kill("SIGTERM");
    else o.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  }

  child.stdin.write(o.stdin);
  child.stdin.end();

  const queue: SSEFrame[] = [];
  let resolveNext: (() => void) | null = null;
  let finished = false;
  let doneResolve!: (v: RunDone) => void;
  const done = new Promise<RunDone>((r) => (doneResolve = r));

  const push = (f: SSEFrame) => {
    queue.push(f);
    if (resolveNext) { resolveNext(); resolveNext = null; }
  };

  let buf = "";
  let stderr = "";
  const acc: RunDone = { isError: false, text: "" };
  let sawStreamEvents = false;

  const handleLine = (line: string) => {
    const t = line.trim();
    if (!t) return;
    let obj: any;
    try { obj = JSON.parse(t); } catch { return; }
    switch (obj.type) {
      case "stream_event":
        if (obj.event && obj.event.type) {
          sawStreamEvents = true;
          const ev = obj.event;
          // accumulate user-facing text for collapse mode
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            acc.text += ev.delta.text ?? "";
          }
          if (ev.type === "message_start" && ev.message) {
            acc.finalMessageId = ev.message.id;
            acc.model = ev.message.model;
          }
          if (ev.type === "message_delta" && ev.delta?.stop_reason) {
            acc.stopReason = ev.delta.stop_reason;
          }
          push({ event: ev.type, data: ev });
        }
        break;
      case "assistant":
        if (!sawStreamEvents && obj.message) synthesizeFromAssistant(obj.message, push);
        if (obj.error && obj.error !== "unknown") acc.errorText = String(obj.error);
        break;
      case "result":
        acc.isError = !!obj.is_error;
        if (obj.is_error) acc.errorText = String(obj.result ?? "claude error");
        acc.usage = obj.usage;
        if (typeof obj.total_cost_usd === "number") acc.cost = obj.total_cost_usd;
        break;
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      handleLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });

  const finalize = () => {
    if (finished) return;
    finished = true;
    if (buf.trim()) handleLine(buf);
    if (!acc.isError && stderr && !sawStreamEvents && queue.length === 0) {
      acc.isError = true;
      acc.errorText = stderr.trim().slice(0, 500);
    }
    doneResolve(acc);
    if (resolveNext) { resolveNext(); resolveNext = null; }
  };
  child.on("close", finalize);
  child.on("error", (e) => { acc.isError = true; acc.errorText = String(e); finalize(); });

  const frames: AsyncIterable<SSEFrame> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SSEFrame>> {
          while (true) {
            if (queue.length) return { value: queue.shift()!, done: false };
            if (finished) return { value: undefined as any, done: true };
            await new Promise<void>((r) => (resolveNext = r));
          }
        },
      };
    },
  };

  return { frames, done };
}

// Fallback SSE synthesis from a consolidated assistant message (older CLIs
// without --include-partial-messages support).
function synthesizeFromAssistant(message: any, push: (f: SSEFrame) => void): void {
  push({ event: "message_start", data: { type: "message_start", message: { ...message, content: [] } } });
  const content = Array.isArray(message.content) ? message.content : [];
  let idx = 0;
  for (const block of content) {
    if (block.type === "text") {
      push({ event: "content_block_start", data: { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } } });
      push({ event: "content_block_delta", data: { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: block.text ?? "" } } });
      push({ event: "content_block_stop", data: { type: "content_block_stop", index: idx } });
      idx++;
    } else if (block.type === "tool_use") {
      push({ event: "content_block_start", data: { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } } });
      push({ event: "content_block_delta", data: { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } } });
      push({ event: "content_block_stop", data: { type: "content_block_stop", index: idx } });
      idx++;
    }
  }
  const stopReason = content.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn";
  push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: message.usage ?? {} } });
  push({ event: "message_stop", data: { type: "message_stop" } });
}

// synthesizeCleanSSE — build ONE clean Anthropic SSE message for pi from a
// collapsed turn. Used in tools mode. `tool` (if present) is the captured MCP
// call with pi's PLAIN tool name.
export function synthesizeCleanSSE(
  d: RunDone,
  tool: { id: string; name: string; input: unknown } | null,
): SSEFrame[] {
  const frames: SSEFrame[] = [];
  const msgId = d.finalMessageId ?? "msg_" + Math.random().toString(36).slice(2);
  frames.push({
    event: "message_start",
    data: { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: d.model ?? "claude", content: [], stop_reason: null, stop_sequence: null, usage: d.usage ?? {} } },
  });
  let idx = 0;
  if (d.text && d.text.length) {
    frames.push({ event: "content_block_start", data: { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } } });
    frames.push({ event: "content_block_delta", data: { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: d.text } } });
    frames.push({ event: "content_block_stop", data: { type: "content_block_stop", index: idx } });
    idx++;
  }
  if (tool) {
    frames.push({ event: "content_block_start", data: { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } } });
    frames.push({ event: "content_block_delta", data: { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input ?? {}) } } });
    frames.push({ event: "content_block_stop", data: { type: "content_block_stop", index: idx } });
    idx++;
  }
  const stopReason = tool ? "tool_use" : "end_turn";
  frames.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: d.usage ?? {} } });
  frames.push({ event: "message_stop", data: { type: "message_stop" } });
  return frames;
}
