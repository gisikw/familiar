/* ============================================================================
 * Local-only inference — one attempt, one provider, no fallback
 * ============================================================================
 *
 * Private turns bypass Pi's model machinery entirely. That is the point: Pi's
 * provider registry brings retries, auto-compaction, branch summarisation,
 * model cycling, and a catalogue of upstream providers with it. None of those
 * may ever see sealed content, so private mode speaks to the router directly
 * with a hand-built request that has no path to any of them.
 *
 * Every request carries `X-Tiamat-Require-Locality: local`. The router refuses
 * with 403 before touching an upstream if the named provider is not attested
 * local, and suppresses its own request/response capture for the request. The
 * client re-checks the attestation itself as well: two independent checks, both
 * fail-closed, neither one trusting a model name.
 */

import { assertNoToolSurface, isRefusal, selectLocalProvider, type LocalChoice, type Providers, type Refusal } from "./policy.ts";

export const REQUIRE_LOCALITY_HEADER = "X-Tiamat-Require-Locality";

export interface RouterConfig {
  readonly baseUrl: string;
  readonly token: string;
}

export interface Message {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export class LocalRoutingError extends Error {}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Fetch the attestation surface. Never logs, never caches to disk. */
export async function fetchProviders(config: RouterConfig, signal?: AbortSignal): Promise<Providers> {
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/tiamat/v1/providers`, {
    headers: { Authorization: `Bearer ${config.token}` },
    redirect: "error",
    signal,
  });
  if (response.status === 401) throw new LocalRoutingError("router rejected the Familiar token");
  if (!response.ok) throw new LocalRoutingError(`router providers returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null) throw new LocalRoutingError("router providers had an invalid shape");
  return value as Providers;
}

/** Discover the local provider to use, or a refusal explaining why not. */
export async function attestLocal(
  config: RouterConfig,
  preference?: string,
  signal?: AbortSignal,
): Promise<LocalChoice | Refusal> {
  const providers = await fetchProviders(config, signal);
  return selectLocalProvider(providers, preference);
}

export interface CompletionResult {
  readonly text: string;
  readonly model: string;
  readonly provider: string;
}

/**
 * One non-streaming completion against one attested-local provider.
 *
 * Deliberately absent: retries, streaming, tools, embeddings, moderation,
 * summarisation helpers, and any notion of a second provider. A failure is a
 * failure; private mode reports it and stays private.
 */
export async function complete(
  config: RouterConfig,
  choice: LocalChoice,
  messages: readonly Message[],
  options: { readonly maxTokens?: number; readonly temperature?: number; readonly signal?: AbortSignal } = {},
): Promise<CompletionResult> {
  if (choice.providerId.includes("/")) throw new LocalRoutingError("invalid provider id");
  const body: Record<string, unknown> = {
    model: choice.model,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    stream: false,
  };
  if (options.maxTokens !== undefined) body["max_tokens"] = options.maxTokens;
  if (options.temperature !== undefined) body["temperature"] = options.temperature;
  assertNoToolSurface(body);

  const url = `${normalizeBaseUrl(config.baseUrl)}/openai/${encodeURIComponent(choice.providerId)}/v1/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      [REQUIRE_LOCALITY_HEADER]: "local",
    },
    body: JSON.stringify(body),
    // A redirect could move the request to a host the locality gate never saw.
    redirect: "error",
    signal: options.signal,
  });
  if (response.status === 403) {
    throw new LocalRoutingError(
      `router refused: "${choice.providerId}" no longer attests locality=local. Nothing was sent.`,
    );
  }
  if (!response.ok) {
    throw new LocalRoutingError(`local provider "${choice.providerId}" returned HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  const text = extractText(payload);
  if (text === undefined) throw new LocalRoutingError("local provider returned no assistant text");
  return { text, model: choice.model, provider: choice.providerId };
}

function extractText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .join("");
  }
  return undefined;
}

/** Re-export for callers that want to narrow an attestation result. */
export { isRefusal };
