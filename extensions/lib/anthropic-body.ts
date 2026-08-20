// anthropic-body.ts — parse an Anthropic Messages API request body into the
// native Message[] shape consumed by claude-projection.ts. This is the port of
// tiamat's server/anthropic.go `anthropicTurnRequest` family, trimmed to what
// the local claude driver needs.
//
// Key rule (from tiamat): tool_result blocks that Anthropic nests inside a user
// message each become their own `role:"tool"` native message, emitted BEFORE
// any trailing user text/image blocks in that same Anthropic message.
import type { ContentBlock, Message } from "./claude-projection.ts";

export interface AnthropicRequest {
  model?: string;
  max_tokens?: number;
  stream?: boolean;
  system?: unknown; // string | array of {type:"text",text}
  messages: AnthropicMessage[];
  tools?: AnthropicToolDef[];
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

interface AnthropicBlock {
  type: string;
  text?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  // image
  source?: { type?: string; media_type?: string; data?: string };
}

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema?: unknown;
}

export interface ParsedRequest {
  system: string; // flattened system prompt ("" if none)
  messages: Message[];
  tools: AnthropicToolDef[];
  model?: string;
  stream: boolean;
  maxTokens?: number;
}

export function systemToString(system: unknown): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((f) => (f && typeof f === "object" && "text" in f ? String((f as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

let seq = 0;
function syntheticId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export function parseAnthropicBody(body: AnthropicRequest): ParsedRequest {
  const messages: Message[] = [];
  const baseTime = Date.now();
  let clock = 0;
  const nextTs = () => new Date(baseTime + clock++).toISOString();

  for (const am of body.messages ?? []) {
    if (typeof am.content === "string") {
      messages.push({ id: syntheticId(am.role), createdAt: nextTs(), role: am.role, content: [{ type: "text", text: am.content }] });
      continue;
    }

    if (am.role === "assistant") {
      const blocks: ContentBlock[] = [];
      for (const b of am.content) {
        if (b.type === "text") blocks.push({ type: "text", text: b.text ?? "" });
        else if (b.type === "tool_use") blocks.push({ type: "tool_use", toolUseId: b.id, toolName: b.name, toolInput: b.input ?? {} });
      }
      if (blocks.length) messages.push({ id: syntheticId("assistant"), createdAt: nextTs(), role: "assistant", content: blocks });
      continue;
    }

    // user message: split tool_results into their own role:"tool" messages
    // (emitted first), then a trailing user message with any text/image blocks.
    const toolMsgs: Message[] = [];
    const trailing: ContentBlock[] = [];
    for (const b of am.content) {
      if (b.type === "tool_result") {
        toolMsgs.push({
          id: syntheticId("tool"),
          createdAt: nextTs(),
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolResultFor: b.tool_use_id,
              toolOutput: toolResultOutput(b.content),
              isError: b.is_error,
            },
          ],
        });
      } else if (b.type === "text") {
        trailing.push({ type: "text", text: b.text ?? "" });
      } else if (b.type === "image" && b.source) {
        trailing.push({ type: "image", imageData: b.source.data, imageMediaType: b.source.media_type });
      }
    }
    for (const tm of toolMsgs) messages.push(tm);
    if (trailing.length) messages.push({ id: syntheticId("user"), createdAt: nextTs(), role: "user", content: trailing });
  }

  return {
    system: systemToString(body.system),
    messages,
    tools: body.tools ?? [],
    model: body.model,
    stream: body.stream !== false,
    maxTokens: body.max_tokens,
  };
}

// Anthropic tool_result.content is string | array of blocks. Flatten to the
// value projectUserMessage expects (string or JSON value).
function toolResultOutput(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => String((b as { text?: unknown }).text ?? ""));
    if (texts.length) return texts.join("\n");
    return content;
  }
  return content ?? "";
}
