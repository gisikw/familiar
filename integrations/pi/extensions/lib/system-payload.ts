/* The system prompt as it actually leaves for the provider.
 *
 * Pi's `before_provider_request` hook exposes the serialized, wire-specific
 * payload. These helpers find and replace the system prompt inside the shapes
 * Familiar's routes actually send, without knowing which provider is active:
 *
 *   - Anthropic Messages:   payload.system — string, or [{ type: "text", text, cache_control? }]
 *   - OpenAI Chat:          payload.messages[i] with role "system" | "developer"
 *   - OpenAI Responses:     payload.instructions (string), or payload.input[i]
 *                           with role "system" | "developer"
 *
 * Anything else reads as `undefined` and is left untouched. Writers never
 * mutate their input; they return a shallow-copied payload.
 */

type Json = Record<string, any>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const SYSTEM_ROLES = new Set(["system", "developer"]);

/** Text of a string-or-text-blocks content value; undefined if it has no text blocks. */
function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((b) => isObject(b) && typeof b.text === "string" && (b.type === "text" || b.type === "input_text"))
    .map((b) => b.text as string);
  return texts.length ? texts.join("\n\n") : undefined;
}

/** Replace a string-or-text-blocks content value with one text, keeping the block shape. */
function withContentText(content: unknown, text: string): unknown {
  if (typeof content === "string" || !Array.isArray(content)) return text;
  const textBlocks = content.filter((b) => isObject(b) && typeof b.text === "string");
  if (textBlocks.length === 0) return text;
  // Collapse to a single text block. Keep the first block's type and any cache
  // marker the provider layer placed (Anthropic puts cache_control on the last
  // system block), so prompt caching behaves as it did.
  const first = textBlocks[0];
  const cache = textBlocks.map((b) => b.cache_control).filter(Boolean).at(-1);
  const block: Json = { ...first, text };
  if (cache) block.cache_control = cache;
  else delete block.cache_control;
  const others = content.filter((b) => !(isObject(b) && typeof b.text === "string"));
  return [block, ...others];
}

function systemMessageIndex(list: unknown): number {
  if (!Array.isArray(list)) return -1;
  return list.findIndex((m) => isObject(m) && SYSTEM_ROLES.has(m.role));
}

/** The system prompt text inside a provider payload, or undefined for an unknown shape. */
export function readSystemText(payload: unknown): string | undefined {
  if (!isObject(payload)) return undefined;
  if ("system" in payload) return contentText(payload.system);
  if (typeof payload.instructions === "string") return payload.instructions;
  for (const key of ["messages", "input"]) {
    const i = systemMessageIndex(payload[key]);
    if (i >= 0) return contentText(payload[key][i].content);
  }
  return undefined;
}

/** A copy of the payload with its system prompt replaced; the input itself if the shape is unknown. */
export function writeSystemText(payload: unknown, text: string): unknown {
  if (!isObject(payload)) return payload;
  if ("system" in payload) return { ...payload, system: withContentText(payload.system, text) };
  if (typeof payload.instructions === "string") return { ...payload, instructions: text };
  for (const key of ["messages", "input"]) {
    const i = systemMessageIndex(payload[key]);
    if (i >= 0) {
      const list = payload[key].slice();
      list[i] = { ...list[i], content: withContentText(list[i].content, text) };
      return { ...payload, [key]: list };
    }
  }
  return payload;
}
