/* ============================================================================
 * Subscriber protocol
 * ============================================================================
 *
 * Lets remote clients (Hearth, future surfaces) attach to the session for
 * voice/text ingress and egress. Models are dumb HTTP endpoints
 * (FAMILIAR_STT_URL, FAMILIAR_TTS_URL). No auth — localhost/tailnet only.
 *
 * Endpoints:
 *   GET  /stream?audio=1            SSE firehose. audio=1 marks an audio
 *                                   listener (drives proactive synthesis).
 *   POST /submit                    Ingress (text or chunked audio takes).
 *   GET  /segments/:mid/:idx/audio  Synthesized wav for a segment.
 *                                   202 = synthesizing (retry), 404 = unknown/evicted, 503 = failed.
 *
 * Stream events (one JSON object per SSE `data:` line):
 *
 *   MessageEvent   — assistant/user message content. `revision` present
 *                    means mutable (a newer revision of the same id
 *                    supersedes it); revision ABSENT means locked — the
 *                    server will never change this message again. There is
 *                    no delta replay and no abort signal: an interrupted
 *                    turn simply locks at its final partial content.
 *   ToolEvent      — tool call liveness. Name + truncated args, no results.
 *   SegmentEvent   — a synthesizable chunk was detected. `synthesizing`
 *                    reports whether synthesis was proactively started
 *                    (true when any audio listener is attached).
 *   SegmentAudioEvent — synthesis finished; fetch via the segments URL.
 *
 * Reconnect: the full in-memory session history (locked events) is replayed
 * on attach, followed by the in-flight revision if a message is mid-stream.
 * Revisions make replay idempotent — clients keep the latest per id.
 *
 * Privacy: turns initiated by handoff/orientation prompts are suppressed
 * from the firehose entirely. Detection fails closed: only a plain user
 * message (no customType) re-opens broadcasting.
 */

export interface MessageEvent {
  event: "message";
  id: number;
  role: "user" | "assistant";
  content: string;
  revision?: number;
}

export interface ToolEvent {
  event: "tool";
  id: string;
  name: string;
  args: string; // JSON, truncated
}

export interface SegmentEvent {
  event: "segment";
  message_id: number;
  index: number;
  text: string;
  synthesizing: boolean;
}

export interface SegmentAudioEvent {
  event: "segment_audio";
  message_id: number;
  index: number;
  ok: boolean;
}

export type StreamEvent = MessageEvent | ToolEvent | SegmentEvent | SegmentAudioEvent;

export type SubmitPayload =
  | { type: "text"; content: string }
  | { type: "audio"; id: number; seq: number; data: string; segments?: number; text?: string };

export const INGRESS_DISPOSITION = "steer";

// Turn initiators whose assistant output must never reach the firehose.
export const PRIVATE_TYPES = new Set(["handoff-request", "orientation"]);

export const TOOL_ARGS_MAX = 300;
export const HISTORY_MAX = 500;
export const AUDIO_CACHE_MAX = 200;

// Segmentation: emit at sentence boundaries ([.!?] followed by whitespace —
// avoids splitting decimals/versions) once the buffer clears a minimum
// length, or at paragraph breaks. On text_end (the model closed its text
// block — moving to a tool call or finishing) the remainder flushes whole,
// so "Give me a minute." doesn't sit unspoken while a tool runs. No idle
// timer: token-stream pauses are cadence, not structure — slow local models
// pause mid-sentence routinely. (Reference: cranium's OutputSegmenter; the
// adaptive lead-time machinery there compensated for slower synthesis and
// is deliberately not carried over.)
export const SEGMENT_MIN_CHARS = 30;
