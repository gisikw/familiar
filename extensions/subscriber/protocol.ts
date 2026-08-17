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
 *   POST /cancel                    Abort the in-flight turn. Idempotent,
 *                                   fire-and-forget, 204 always. The
 *                                   interrupted message locks at its partial
 *                                   content (the existing abort protocol).
 *   GET  /segments/:mid/:idx/audio  Synthesized wav for a segment.
 *                                   202 = synthesizing (retry), 404 = unknown/evicted, 503 = failed.
 *
 * Stream events (one JSON object per SSE `data:` line):
 *
 *   SessionEvent   — sent to every client as the FIRST event on each attach,
 *                    before history replay; never part of history. The id is
 *                    minted per server process: a changed id means the
 *                    message-id space reset — drop any cached transcript and
 *                    take the replay as truth.
 *   MessageEvent   — assistant/user message content. `revision` present
 *                    means mutable (a newer revision of the same id
 *                    supersedes it); revision ABSENT means locked — the
 *                    server will never change this message again. There is
 *                    no delta replay and no abort signal: an interrupted
 *                    turn simply locks at its final partial content.
 *                    `created_at` is the ISO time the message began, stable
 *                    across revisions. `correlation_id` on a user message
 *                    echoes the client-chosen submit id (take or text) that
 *                    produced it.
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

export interface SessionEvent {
  event: "session";
  /** Epoch id, minted per server process. Never appears in history. */
  id: string;
}

export interface MessageEvent {
  event: "message";
  id: number;
  role: "user" | "assistant";
  content: string;
  revision?: number;
  /** ISO timestamp of message creation; stable across revisions. */
  created_at?: string;
  /** Client-chosen submit id (take or text) echoed on the user message it produced. */
  correlation_id?: number;
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
  | { type: "text"; content: string; id?: number }
  | { type: "audio"; id: number; seq: number; data: string; segments?: number; text?: string };

export const INGRESS_DISPOSITION = "steer";

// Turn initiators whose assistant output must never reach the firehose.
export const PRIVATE_TYPES = new Set(["handoff-request", "orientation"]);

export const TOOL_ARGS_MAX = 300;
export const HISTORY_MAX = 500;
export const AUDIO_CACHE_MAX = 200;
// Dispatched-but-unechoed submits kept for correlation matching.
export const PENDING_ECHO_MAX = 50;

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
