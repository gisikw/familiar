// integrations/pi/extensions/anthropic-gateway/index.ts — point pi's anthropic provider at an alternate
// Anthropic-compatible gateway. No-op when ANTHROPIC_BASE_URL is unset.
// Auth rides pi's native ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY handling.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (baseUrl) pi.registerProvider("anthropic", { baseUrl });
}
