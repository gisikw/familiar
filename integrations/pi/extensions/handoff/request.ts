/**
 * Tiamat's Codex-backed Responses adapter rejects max_output_tokens. Direct
 * modelRegistry.complete() calls bypass the Tiamat extension's ordinary
 * before_provider_request payload hook, so callers must omit maxTokens here.
 */
export function handoffMaxTokens(provider: string | undefined, desired: number): number | undefined {
  return provider?.startsWith("tiamat-responses-") ? undefined : desired;
}
