/**
 * Tiamat's Codex-backed Responses adapter rejects max_output_tokens. Direct
 * modelRegistry.complete() calls bypass the Tiamat extension's ordinary
 * before_provider_request payload hook, so callers must omit maxTokens here.
 */
function rejectsNoReasoning(message: string): boolean {
  return /\bnone\b/i.test(message)
    && /unsupported|not supported/i.test(message)
    && /\blow\b/i.test(message);
}

/** Retry only an explicit rejection of no reasoning, never arbitrary failures. */
export async function completeHandoff<T extends { stopReason: string; errorMessage?: string }>(
  complete: (reasoning?: "low") => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let response: T;
  try {
    response = await complete();
  } catch (error) {
    if (signal.aborted || !rejectsNoReasoning(error instanceof Error ? error.message : String(error))) throw error;
    return complete("low");
  }
  if (!signal.aborted && response.stopReason === "error" && rejectsNoReasoning(response.errorMessage ?? "")) {
    return complete("low");
  }
  return response;
}

export function handoffMaxTokens(provider: string | undefined, desired: number): number | undefined {
  return provider?.startsWith("tiamat-responses-") ? undefined : desired;
}
