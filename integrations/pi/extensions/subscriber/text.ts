// Text extraction and speakability reduction for the firehose.

export function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
}

// Reduce markdown to speakable text for synthesis. Code block fences are
// stripped but contents are spoken — airpod-driven development needs the
// code, tedious as Kokoro reading it may occasionally be.
export function speakable(text: string): string {
  return text
    .replace(/^```[^\n]*$/gm, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>\s]*#+\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/([*_~]{1,3})(\S(?:[^\n]*?\S)?)\1/g, "$2")
    .replace(/[ \t]+/g, " ")
    .trim();
}
