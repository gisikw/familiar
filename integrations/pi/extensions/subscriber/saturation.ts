import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
};

type TurnMessage = { role?: string; stopReason?: string; usage?: Usage };

/**
 * Return Hearth's 0..1 context saturation value.
 *
 * Pi's getContextUsage() is authoritative because it accounts for compaction
 * and trailing context. The message-usage branch is only a compatibility
 * fallback for a Pi without that API; it uses provider token accounting and
 * the current model window, never text length.
 */
export function contextSaturation(
  ctx: Pick<ExtensionContext, "getContextUsage" | "model">,
  message?: TurnMessage,
): number | undefined {
  const measured = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
  if (measured?.tokens != null && Number.isFinite(measured.tokens)
    && Number.isFinite(measured.contextWindow) && measured.contextWindow > 0) {
    return clamp(measured.tokens / measured.contextWindow);
  }

  const usage = message?.role === "assistant"
    && message.stopReason !== "aborted" && message.stopReason !== "error"
    ? message.usage : undefined;
  const contextWindow = ctx.model?.contextWindow;
  if (!usage || typeof contextWindow !== "number"
    || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const components = (usage.input ?? 0) + (usage.output ?? 0)
    + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const tokens = usage.totalTokens && usage.totalTokens > 0 ? usage.totalTokens : components;
  return Number.isFinite(tokens) && tokens >= 0 ? clamp(tokens / contextWindow) : undefined;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
