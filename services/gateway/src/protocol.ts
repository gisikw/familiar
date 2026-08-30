/* ============================================================================
 * Familiar server protocol (moved here from integrations/pi/extensions/subscriber/protocol.ts)
 * ============================================================================
 *
 * The web server owns all HTTP. Remote clients (Hearth, browser terminal,
 * future surfaces) attach to the session for voice/text ingress and egress.
 * Models are dumb HTTP endpoints (FAMILIAR_STT_URL, FAMILIAR_TTS_URL) the
 * SERVER calls. No auth — the server binds localhost only (put an
 * authenticating reverse proxy in front for remote deployments).
 *
 * The pi `subscriber` extension is now a thin relay: its firehose still turns
 * pi events into StreamEvents, but forwards them to the server's /ingest
 * endpoint instead of an in-process hub. The extension imports the types +
 * a couple of constants it still needs from this file.
 *
 * Endpoints (server):
 *   GET  /stream?audio=1            SSE firehose. audio=1 marks an audio
 *                                   listener (drives proactive synthesis).
 *   POST /ingest                    Egress from the extension (IngestEnvelope).
 *   POST /submit                    Ingress (text or chunked audio takes).
 *   POST /voice-status              Browser capture lifecycle before audio exists.
 *   POST /cancel                    Abort the in-flight turn. Idempotent,
 *                                   fire-and-forget, 204 always.
 *   GET  /relay                     SSE command bus, server → extension
 *                                   (RelayCommand: submit / cancel / voice-status). The
 *                                   extension is the only subscriber; it owns
 *                                   the pi API (sendUserMessage / abort).
 *   GET  /segments/:mid/:idx/audio  Synthesized wav for a segment.
 *                                   202 = synthesizing (retry), 404 = unknown/evicted, 503 = failed.
 *   GET  /terminal, /               Browser terminal (restty WASM).
 *   GET  /pty  (WebSocket)          restty PTY protocol bridged to a Presence attach.
 *
 * Stream events (one JSON object per SSE `data:` line on /stream):
 *
 *   SessionEvent   — sent to every client as the FIRST event on each attach,
 *                    before history replay; never part of history. The id is
 *                    minted per server process AND re-minted when the pi
 *                    session restarts (the extension announces a new session
 *                    on /ingest). A changed id means the message-id space
 *                    reset — drop any cached transcript, take replay as truth.
 *                    `saturation`, when known, snapshots the latest context
 *                    ratio (0..1) reported after a completed Pi turn.
 *   MessageEvent   — assistant/user message content. `revision` present means
 *                    mutable (a newer revision of the same id supersedes it);
 *                    revision ABSENT means locked. No delta replay, no abort
 *                    signal: an interrupted turn locks at its final partial.
 *                    Assistant `parts`, when present, are the authoritative
 *                    ordered text/tool-call projection; `content` remains its
 *                    legacy text-only projection. `created_at` is the ISO time
 *                    the message began, stable across revisions.
 *                    `correlation_id` on a user message echoes the
 *                    client-chosen submit id that produced it.
 *   ToolEvent      — tool call liveness. Name + truncated args, no results;
 *                    `message_id` associates it with its assistant message.
 *   SegmentEvent   — a synthesizable chunk was detected. `synthesizing`
 *                    reports whether synthesis was proactively started
 *                    (true when any audio listener is attached) — decided by
 *                    the SERVER, which owns the audio listener registry.
 *   SegmentAudioEvent — synthesis finished; fetch via the segments URL.
 *   SaturationEvent — latest Pi context-window usage as a ratio (0..1).
 *                     It is live telemetry, not transcript history; the latest
 *                     value is repeated on SessionEvent at every attach.
 *
 * Reconnect: the full in-memory session history (locked events) is replayed
 * on attach, followed by the in-flight revision if a message is mid-stream.
 *
 * Privacy: turns initiated by handoff/orientation prompts are suppressed from
 * the firehose entirely (fails closed in the extension firehose).
 */

export interface SessionEvent {
  event: "session";
  /** Epoch id, re-minted per pi session. Never appears in history. */
  id: string;
  /** Latest known context-window usage ratio (0..1); absent until measured. */
  saturation?: number;
}

export interface SaturationEvent {
  event: "saturation";
  /** Context tokens divided by the active model's context window, clamped to 0..1. */
  saturation: number;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; args: string };

export interface MessageEvent {
  event: "message";
  id: number;
  role: "user" | "assistant";
  /** Legacy text-only projection; concatenate text parts to obtain this value. */
  content: string;
  /** Authoritative ordered assistant content, additive for wire compatibility. */
  parts?: MessagePart[];
  revision?: number;
  /** ISO timestamp of message creation; stable across revisions. */
  created_at?: string;
  /** Client-chosen submit id echoed on the user message it produced. */
  correlation_id?: number;
}

export interface ToolEvent {
  event: "tool";
  id: string;
  name: string;
  args: string; // JSON, truncated
  /** Assistant message that owns this call; absent on legacy producers. */
  message_id?: number;
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

export type StreamEvent = MessageEvent | ToolEvent | SegmentEvent | SegmentAudioEvent | SaturationEvent;

/* --- extension ⇄ server wire envelopes ------------------------------------ */

// Egress: the extension's RelayHub forwards each hub operation faithfully.
//   publish  → recorded in history + broadcast (locked messages, tools, segments)
//   revise   → broadcast only, replaces the in-flight revision (mutable messages)
//   lock     → clears the in-flight revision (the whole abort protocol)
//   session  → new pi session: re-mint the epoch id, clear history
export type IngestEnvelope =
  | { kind: "publish"; event: StreamEvent }
  | { kind: "revise"; event: MessageEvent }
  | { kind: "lock" }
  | { kind: "session" };

// Ingress: commands the server pushes down /relay for the extension to enact
// against the pi API. STT/TTS are resolved server-side, so a submit carries
// ready-to-dispatch text parts; the extension appends the live editor draft,
// records the echo for correlation, and calls pi.sendUserMessage.
export interface SubmitCommand {
  type: "submit";
  /** Client-chosen submit id (take or text); echoed on the user message. */
  correlationId?: number;
  /** Ordered text parts to dispatch (already transcribed / marked). */
  parts: string[];
}
export interface CancelCommand { type: "cancel"; }
export type VoicePhase = "capturing" | "transcribing" | "idle";
export interface VoiceStatusCommand {
  type: "voice-status";
  phase: VoicePhase;
  /** Gateway emission time; consumers use this (then seq) to reject stale delivery. */
  timestamp: number;
  /** Gateway receive-order tie breaker. */
  seq: number;
  takeId?: number;
}
export type RelayCommand = SubmitCommand | CancelCommand | VoiceStatusCommand;

export type VoiceStatusPayload = {
  phase: VoicePhase;
  timestamp: number;
  takeId?: number;
};

export type SubmitPayload =
  | { type: "text"; content: string; id?: number }
  | { type: "audio"; id: number; seq: number; data: string; segments?: number; text?: string };

export const INGRESS_DISPOSITION = "steer";

// Turn initiators whose assistant output must never reach the firehose.
export const PRIVATE_TYPES = new Set(["handoff-request", "orientation", "handoff-orientation"]);

export const TOOL_ARGS_MAX = 300;
export const HISTORY_MAX = 500;
export const AUDIO_CACHE_MAX = 200;
// Dispatched-but-unechoed submits kept for correlation matching.
export const PENDING_ECHO_MAX = 50;
// Bounded relay buffer in the extension when the server is unreachable.
export const RELAY_QUEUE_MAX = 200;

// Segmentation: emit at sentence boundaries ([.!?] followed by whitespace)
// once the buffer clears a minimum length, or at paragraph breaks. On
// text_end the remainder flushes whole. No idle timer.
export const SEGMENT_MIN_CHARS = 30;
