// claude-runner.ts — spawn a single-shot headless `claude -p` and translate its
// stream-json stdout into Anthropic Messages SSE frames.
//
// KEY FINDING (verified against claude CLI 2.1.197): with
// `--include-partial-messages`, claude emits `{"type":"stream_event","event":{…}}`
// lines whose `.event` payload is VERBATIM Anthropic SSE (message_start,
// content_block_start/delta/stop, message_delta, message_stop). So the pi-facing
// gateway forwards those `.event` objects straight through — no re-synthesis of
// text deltas needed. The trailing `{"type":"result",…}` line carries
// authoritative usage/cost and is used only as a fallback + for teardown.
//
// Env hygiene: inherited ANTHROPIC_* (e.g. pi's tiamat ANTHROPIC_BASE_URL /
// ANTHROPIC_API_KEY) MUST be scrubbed or claude routes to the wrong backend and
// 400s ("unsupported role system"). We set exactly the env claude needs.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface RunnerOptions {
  prompt: string; // stdin user line (v0) — the trailing user text
  configDir: string; // CLAUDE_CONFIG_DIR (ephemeral, holds .credentials.json)
  claudeBaseUrl?: string; // claude's ANTHROPIC_BASE_URL → loopback B (optional)
  model?: string;
  systemPromptFile?: string;
  sessionId?: string; // --session-id (fresh) — omit to let claude generate
  resume?: string; // --resume <id>
  mcpConfigFile?: string;
  allowedTools?: string[];
  cwd?: string;
  signal?: AbortSignal;
}

export interface SSEFrame {
  event: string;
  data: unknown;
}

export interface RunResult {
  frames: AsyncIterable<SSEFrame>;
  done: Promise<{ isError: boolean; errorText?: string; usage?: unknown; cost?: number }>;
}

// Build the argv. Kept close to tiamat's DispatchStream invocation.
export function buildArgs(o: RunnerOptions): string[] {
  const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
  if (o.resume) args.push("--resume", o.resume);
  else if (o.sessionId) args.push("--session-id", o.sessionId);
  if (o.systemPromptFile) args.push("--system-prompt-file", o.systemPromptFile);
  if (o.mcpConfigFile) args.push("--strict-mcp-config", "--mcp-config", o.mcpConfigFile);
  if (o.model) args.push("--model", o.model);
  if (o.allowedTools && o.allowedTools.length) args.push("--allowedTools=" + o.allowedTools.join(","));
  return args;
}

export function buildEnv(o: RunnerOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Scrub inherited tiamat routing and the source OAuth secret. The latter
    // has already been materialized into CLAUDE_CONFIG_DIR/.credentials.json;
    // the child neither needs nor should inherit it.
    if (k.startsWith("ANTHROPIC_") || k === "FAMILIAR_ANTHROPIC_OAUTH") continue;
    env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = o.configDir;
  if (o.claudeBaseUrl) env.ANTHROPIC_BASE_URL = o.claudeBaseUrl;
  return env;
}

export function runClaude(o: RunnerOptions): RunResult {
  const args = buildArgs(o);
  const child: ChildProcessWithoutNullStreams = spawn("claude", args, {
    env: buildEnv(o),
    cwd: o.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  if (o.signal) {
    if (o.signal.aborted) child.kill("SIGTERM");
    else o.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  }

  // v0: single user line on stdin (Anthropic stream-json input not required —
  // claude -p accepts the prompt as text stdin when not using --input-format).
  child.stdin.write(o.prompt);
  child.stdin.end();

  const queue: SSEFrame[] = [];
  let resolveNext: (() => void) | null = null;
  let finished = false;
  let doneResolve!: (v: { isError: boolean; errorText?: string; usage?: unknown; cost?: number }) => void;
  const done = new Promise<{ isError: boolean; errorText?: string; usage?: unknown; cost?: number }>((r) => (doneResolve = r));

  const push = (f: SSEFrame) => {
    queue.push(f);
    if (resolveNext) { resolveNext(); resolveNext = null; }
  };

  let buf = "";
  let stderr = "";
  let result: { isError: boolean; errorText?: string; usage?: unknown; cost?: number } = { isError: false };
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
          push({ event: obj.event.type, data: obj.event });
        }
        break;
      case "assistant":
        // Non-partial fallback: if the CLI ever omits stream_events (older
        // versions / --include-partial-messages unsupported), synthesize from
        // the consolidated assistant message.
        if (!sawStreamEvents && obj.message) {
          synthesizeFromAssistant(obj.message, push);
        }
        // capture error text surfaced as an assistant text block
        if (obj.error && obj.error !== "unknown") result.errorText = String(obj.error);
        break;
      case "result":
        result = {
          isError: !!obj.is_error,
          errorText: obj.is_error ? String(obj.result ?? "claude error") : undefined,
          usage: obj.usage,
          cost: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
        };
        break;
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      handleLine(line);
    }
  });
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });

  const finalize = () => {
    if (finished) return;
    finished = true;
    if (buf.trim()) handleLine(buf);
    if (!result.isError && stderr && !sawStreamEvents && queue.length === 0) {
      result = { isError: true, errorText: stderr.trim().slice(0, 500) };
    }
    doneResolve(result);
    if (resolveNext) { resolveNext(); resolveNext = null; }
  };
  child.on("close", finalize);
  child.on("error", (e) => { result = { isError: true, errorText: String(e) }; finalize(); });

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

// Fallback SSE synthesis from a consolidated assistant message (no partials).
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
