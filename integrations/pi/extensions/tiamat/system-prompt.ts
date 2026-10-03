import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSystemText } from "../lib/system-payload.ts";

export const SYSTEM_PROMPT_ENTRY = "familiar.system-prompt.v1";

/* Audit record of the system prompt that actually went to the provider.
 *
 * This used to read ctx.getSystemPrompt() at agent_start. That is Pi's agent
 * state, not the wire: runs started with triggerTurn skip before_agent_start,
 * and Pi's next-turn refresh swaps in its own base prompt after each tool call,
 * so the record and the request disagreed (Oct 3 2026, tiamat captures). Read
 * the serialized payload instead. Extensions load in sorted order, so identity's
 * wire guard has already run when this sees the payload. Recorded only when it
 * changes on the current branch.
 */
export function registerSystemPromptRecorder(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    const text = readSystemText(event.payload);
    if (text === undefined) return undefined;
    const sha256 = createHash("sha256").update(text).digest("hex");
    const previous = ctx.sessionManager.getBranch().findLast(
      (entry) => entry.type === "custom" && entry.customType === SYSTEM_PROMPT_ENTRY,
    );
    if ((previous?.data as { sha256?: unknown } | undefined)?.sha256 === sha256)
      return undefined;
    pi.appendEntry(SYSTEM_PROMPT_ENTRY, { sha256, text });
    return undefined;
  });
}
