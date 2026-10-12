import { TOOL_ARGS_MAX, type MessagePart } from "./protocol.ts";

// Text extraction and wire-safe content projection for the firehose.

export function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
}

export function toolArgs(args: any): string {
  let summary = "";
  try {
    summary = JSON.stringify(args) ?? "";
  } catch {
    summary = String(args);
  }
  return summary.length > TOOL_ARGS_MAX ? summary.slice(0, TOOL_ARGS_MAX) + "…" : summary;
}

/** Preserve provider order while exposing only text and executable tool calls. */
export function messageParts(message: any): MessagePart[] {
  if (!Array.isArray(message?.content)) {
    const text = typeof message?.content === "string" ? message.content : "";
    return text ? [{ type: "text", text }] : [];
  }
  const parts: MessagePart[] = [];
  for (const block of message.content) {
    if (block?.type === "text" && typeof block.text === "string") {
      if (block.text) parts.push({ type: "text", text: block.text });
    } else if (block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
      parts.push({ type: "tool", id: block.id, name: block.name, args: toolArgs(block.arguments) });
    }
  }
  return parts;
}

// Inline default chips ("Want it carded? [yes]") are UI affordances, not
// speech: the web renders them as tappable buttons, and Kes must never be
// heard saying "bracket yes". Mirrors CHIP_RE/chipText in familiar-ui
// packages/web/src/ui/markdown.ts — change both together.
const CHIP_LINE_END = /[ \t]*\[([A-Za-z][^\[\]\n()`*_<>|]{0,31})\](?![(\[:])(?=[ \t]*$)/gm;

export function stripChips(text: string): string {
  return text.replace(CHIP_LINE_END, (all, inner: string) => {
    const t = inner.trim();
    if (!t || t.length > 32 || t.split(/\s+/).length > 4) return all;
    if (/^x$/i.test(t) || /https?:|\//.test(t)) return all;
    return "";
  });
}

// Reduce markdown to speakable text for synthesis. Code block fences are
// stripped but contents are spoken — airpod-driven development needs the
// code, tedious as Kokoro reading it may occasionally be.
export function speakable(text: string): string {
  return stripChips(text)
    .replace(/^```[^\n]*$/gm, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>\s]*#+\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/([*_~]{1,3})(\S(?:[^\n]*?\S)?)\1/g, "$2")
    .replace(/[ \t]+/g, " ")
    .trim();
}
