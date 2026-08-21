// ratelimit-headers.ts — select the ratelimit-relevant headers from an upstream
// api.anthropic.com response (port of tiamat turn/claude_gateway_ratelimit.go
// rateLimitHeaders). Loopback B captures these off Claude's REAL upstream call
// and the driver re-emits them on loopback A's response so pi's existing
// after_provider_response → extensions/ratelimit/index.ts footer lights up unchanged.
//
// Verified against a live upstream capture (2.1.197): the full
// anthropic-ratelimit-unified-* set + request-id are present on 200s;
// retry-after appears on 429s.
export function selectRatelimitHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (lk.startsWith("anthropic-ratelimit-") || lk === "retry-after" || lk === "request-id" || lk === "anthropic-request-id") {
      out[lk] = Array.isArray(v) ? v.join(",") : String(v);
    }
  }
  return out;
}
