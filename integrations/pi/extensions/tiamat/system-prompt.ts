import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SYSTEM_PROMPT_ENTRY = "familiar.system-prompt.v1";

export function registerSystemPromptRecorder(pi: ExtensionAPI): void {
  pi.on("agent_start", (_event, ctx) => {
    const text = ctx.getSystemPrompt();
    const sha256 = createHash("sha256").update(text).digest("hex");
    const previous = ctx.sessionManager.getBranch().findLast(
      (entry) => entry.type === "custom" && entry.customType === SYSTEM_PROMPT_ENTRY,
    );
    if ((previous?.data as { sha256?: unknown } | undefined)?.sha256 === sha256)
      return;
    pi.appendEntry(SYSTEM_PROMPT_ENTRY, { sha256, text });
  });
}
