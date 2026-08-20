// claude-cache-hygiene.ts — faithful TS port of tiamat's claude-facing wire
// hygiene (turn/claude_gateway.go + claude_gateway_cache.go). Applied on
// LOOPBACK B to claude's OUTBOUND POST /v1/messages before forwarding upstream.
//
// PURPOSE: prompt-cache economics, NOT hiding client identity. Claude Code
// resumes a session whose leaf is a tool_result by appending a synthetic
// artifact tail — an assistant "No response requested." bridge and a user
// "<tool-result>…</tool-result>" continuation block — and parks its prompt-cache
// breakpoint (cache_control) on that continuation block. If we forward that
// verbatim, the cache anchor sits on a block whose bytes change every turn, so
// the whole context re-bills as fresh input each turn (→ cost blowup / 429).
//
// The fix (verified against a REAL 2.1.197 upstream capture — the tail and the
// breakpoint placement are exactly as tiamat observed):
//   1. relocateClaudeContinuationCacheControl — MOVE the continuation block's
//      cache_control onto the real tool_result that precedes it.
//   2. stripClaudeContinuationArtifacts — remove the exact trailing
//      assistant/continuation pair, COUPLED with relocateBreakpointsBeforeCut so
//      no breakpoint carried by a removed block is orphaned.
// Both passes only MOVE existing breakpoints (never add), so Anthropic's
// max-4-breakpoints constraint can never be exceeded.
//
// DETERMINISM: when there is nothing to do, the ORIGINAL bytes are returned
// unchanged (no reparse) so the cached prefix stays byte-identical. When we
// mutate, we JSON.parse → mutate → JSON.stringify; JSON.stringify preserves the
// key order from parse, mirroring claude's serialization, so the stable prefix
// is reproduced identically turn over turn.

const CONTINUATION_PROMPT = "<tool-result>Tool call complete. Results are above.</tool-result>";
const ALT_CONTINUATION = "Continue from where you left off.";
const NO_RESPONSE = "No response requested.";

type Block = Record<string, any>;
type Msg = Record<string, any>;

function isContinuationCacheBlock(block: Block): boolean {
  if (block.type !== "text" || block.cache_control == null) return false;
  const text = String(block.text ?? "").trim();
  return text === CONTINUATION_PROMPT.trim() || text === ALT_CONTINUATION.trim();
}

function latestToolResultBlockBefore(messages: Msg[], before: number): Block | null {
  for (let i = before - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (block && typeof block === "object" && block.type === "tool_result") return block;
    }
  }
  return null;
}

// relocateClaudeContinuationCacheControl — port. Returns [body, mutations].
export function relocateClaudeContinuationCacheControl(body: string): { body: string; mutations: number } {
  let payload: any;
  try { payload = JSON.parse(body); } catch { throw new Error("relocate: invalid JSON body"); }
  const messages: Msg[] = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { body, mutations: 0 };
  let mutations = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    const content = msg.content;
    if (!Array.isArray(content) || content.length !== 1) continue;
    const block = content[0];
    if (!block || typeof block !== "object" || !isContinuationCacheBlock(block)) continue;
    const cc = block.cache_control;
    if (cc == null) continue;
    const target = latestToolResultBlockBefore(messages, i);
    if (!target) continue;
    delete block.cache_control;
    target.cache_control = cc;
    mutations++;
    break;
  }
  if (mutations === 0) return { body, mutations: 0 };
  return { body: JSON.stringify(payload), mutations };
}

function isArtifactTextMessage(value: any, role: string, text: string): boolean {
  if (!value || typeof value !== "object" || value.role !== role) return false;
  const content = value.content;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const block = content[0];
  if (!block || typeof block !== "object" || block.type !== "text") return false;
  return String(block.text ?? "").trim() === text.trim();
}

// nearestSurvivingBlock — the last content block of the last surviving message.
function nearestSurvivingBlock(messages: Msg[], cut: number): Block | null {
  for (let i = cut - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const content = msg.content;
    if (!Array.isArray(content) || content.length === 0) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (block && typeof block === "object") return block;
    }
  }
  return null;
}

// relocateBreakpointsBeforeCut — port. Moves an existing breakpoint carried by a
// removed block onto the nearest surviving prior block. Returns count removed.
export function relocateBreakpointsBeforeCut(messages: Msg[], cut: number): number {
  if (cut <= 0 || cut > messages.length) return 0;
  const removed: any[] = [];
  for (let i = cut; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && block.cache_control != null) removed.push(block.cache_control);
    }
  }
  if (removed.length === 0) return 0;
  const target = nearestSurvivingBlock(messages, cut);
  if (!target) return removed.length;
  if (target.cache_control != null) return removed.length; // anchor already survives
  target.cache_control = removed[removed.length - 1];
  return removed.length;
}

// stripClaudeContinuationArtifacts — port. Returns [body, strips].
export function stripClaudeContinuationArtifacts(body: string): { body: string; strips: number } {
  let payload: any;
  try { payload = JSON.parse(body); } catch { throw new Error("strip: invalid JSON body"); }
  const messages: Msg[] = payload.messages;
  if (!Array.isArray(messages) || messages.length < 3) return { body, strips: 0 };
  const assistantIndex = messages.length - 2;
  const continuationIndex = messages.length - 1;
  if (
    !isArtifactTextMessage(messages[assistantIndex], "assistant", NO_RESPONSE) ||
    !isArtifactTextMessage(messages[continuationIndex], "user", CONTINUATION_PROMPT) ||
    latestToolResultBlockBefore(messages, assistantIndex) == null
  ) {
    return { body, strips: 0 };
  }
  relocateBreakpointsBeforeCut(messages, assistantIndex);
  payload.messages = messages.slice(0, assistantIndex);
  return { body: JSON.stringify(payload), strips: 2 };
}

// applyCacheHygiene — the coupled relocate-then-strip sequence (port of
// StripContinuationArtifactsForFacade). Idempotent: a body with no artifact tail
// passes through UNCHANGED (original bytes). Returns the possibly-rewritten body
// plus counters for logging.
export function applyCacheHygiene(body: string): { body: string; cacheRewrites: number; strips: number } {
  const r = relocateClaudeContinuationCacheControl(body);
  const s = stripClaudeContinuationArtifacts(r.body);
  return { body: s.body, cacheRewrites: r.mutations, strips: s.strips };
}

// countCacheControlBlocks — total cache_control breakpoints in messages content
// (for the max-4 invariant tests). Does NOT count the system array or tools.
export function countCacheControlBlocks(messages: Msg[]): number {
  let count = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && block.cache_control != null) count++;
    }
  }
  return count;
}
