/*
 * /rewind: the one /tree move Kev actually uses, without the TUI.
 *
 * Pick a checkpoint on the active branch, move the leaf there, no summary.
 * Nothing is deleted; the abandoned branch stays in the session file.
 *
 * Pi's navigateTree already encodes the semantics we want:
 *   - an assistant message: the leaf becomes that message; everything after
 *     it is set aside.
 *   - a user message: the leaf becomes its parent and the text is handed back
 *     for editing, so the message itself is set aside too (edit and resend).
 *
 * This module only decides whether a target is safe and describes what will
 * happen, so the command and the browser can agree before anything moves.
 */

export type BranchEntry = {
  id: string;
  parentId?: string | null;
  type: string;
  message?: { role?: string; content?: unknown; stopReason?: string };
};

export type RewindPlan =
  | {
      ok: true;
      targetId: string;
      kind: "assistant" | "user";
      /** Entries on the active branch that leave context. */
      dropped: number;
      /** For a user target: the text that goes back to the composer. */
      editorText?: string;
    }
  | { ok: false; error: string };

const hasToolCall = (content: unknown): boolean =>
  Array.isArray(content) && content.some((part: any) => part?.type === "toolCall");

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
};

/** A target is rewindable when the conversation can continue cleanly from it. */
export const rewindKind = (entry: BranchEntry): "assistant" | "user" | undefined => {
  if (entry.type !== "message" || !entry.message) return undefined;
  if (entry.message.role === "user") return "user";
  // An assistant message that asked for tools would leave dangling tool calls
  // with no results; only turn-ending replies are checkpoints.
  if (entry.message.role === "assistant" && !hasToolCall(entry.message.content)) return "assistant";
  return undefined;
};

export const planRewind = (branch: readonly BranchEntry[], targetId: string): RewindPlan => {
  const id = targetId.replace(/^#/, "").trim();
  if (!id) return { ok: false, error: "Usage: /rewind <entryId>" };
  const index = branch.findIndex((entry) => entry.id === id);
  if (index < 0) return { ok: false, error: `entry ${id} is not on the active branch` };
  const kind = rewindKind(branch[index]!);
  if (!kind) return { ok: false, error: "rewind targets are your messages or Kes's turn-ending replies" };
  // A user target is itself set aside (its text comes back for editing).
  const dropped = branch.length - index - (kind === "user" ? 0 : 1);
  if (dropped <= 0) return { ok: false, error: "already at that point; nothing to set aside" };
  return {
    ok: true,
    targetId: id,
    kind,
    dropped,
    ...(kind === "user" ? { editorText: textOf(branch[index]!.message!.content) } : {}),
  };
};
