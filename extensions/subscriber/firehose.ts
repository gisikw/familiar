import {
  PRIVATE_TYPES,
  SEGMENT_MIN_CHARS,
  TOOL_ARGS_MAX,
} from "./protocol.ts";
import { messageText, speakable } from "./text.ts";
import type { StreamHub } from "./hub.ts";
import type { AudioCache } from "./audio.ts";

/* --- Firehose: pi events → stream events ---------------------------------- */

export class Firehose {
  private messageId = 0;
  private revisionId = 1;
  private consumed = 0; // segmentation offset into the in-flight message text
  private segmentIndex = 0;
  private privateTurn = false;
  private streamingAssistant = false;

  constructor(private hub: StreamHub, private audio: AudioCache) { }

  onMessageStart(message: any) {
    const customType = message?.customType;
    if (typeof customType === "string") {
      // Fails closed: only a plain user message re-opens broadcasting.
      if (PRIVATE_TYPES.has(customType)) this.privateTurn = true;
      return;
    }
    if (message?.role === "user") {
      this.privateTurn = false;
      const content = messageText(message);
      if (content.trim()) {
        this.hub.publish({ event: "message", id: ++this.messageId, role: "user", content });
      }
    } else if (message?.role === "assistant") {
      this.beginAssistant();
    }
  }

  onMessageUpdate(message: any, assistantMessageEvent: any) {
    const type = assistantMessageEvent?.type;
    if (type !== "text_start" && type !== "text_delta" && type !== "text_end") return;
    if (this.privateTurn) return;
    if (!this.streamingAssistant) this.beginAssistant();

    const content = messageText(assistantMessageEvent.partial ?? message);
    if (content.trim()) {
      this.hub.revise({
        event: "message",
        id: this.messageId,
        role: "assistant",
        content,
        revision: this.revisionId++,
      });
    }
    // text_end = the model closed this text block (moving to a tool call or
    // finishing) — pending text is complete by definition, so flush it all.
    // No idle timer: a token-stream pause is cadence, not structure, and
    // slow local models pause mid-sentence all the time.
    this.chunkSegments(content, type === "text_end");
  }

  onMessageEnd(message: any) {
    if (message?.role !== "assistant") return;
    this.finishAssistant(messageText(message));
  }

  // Safety net for turns that never see message_end (interruption): lock
  // whatever we have. Locked-without-revision is the whole abort protocol.
  onAgentEnd() {
    if (this.streamingAssistant && this.hub.inflight) {
      this.finishAssistant(this.hub.inflight.content);
    }
    this.streamingAssistant = false;
    this.privateTurn = false;
  }

  onToolStart(toolCallId: string, toolName: string, args: any) {
    if (this.privateTurn) return;
    let summary = "";
    try {
      summary = JSON.stringify(args) ?? "";
    } catch {
      summary = String(args);
    }
    if (summary.length > TOOL_ARGS_MAX) summary = summary.slice(0, TOOL_ARGS_MAX) + "…";
    this.hub.publish({ event: "tool", id: toolCallId, name: toolName, args: summary });
  }

  private beginAssistant() {
    this.streamingAssistant = true;
    this.messageId++;
    this.revisionId = 1;
    this.consumed = 0;
    this.segmentIndex = 0;
  }

  private finishAssistant(content: string) {
    if (!this.streamingAssistant) return;
    this.streamingAssistant = false;
    this.hub.lockInflight();
    if (!this.privateTurn) {
      this.chunkSegments(content, true);
      if (content.trim()) {
        this.hub.publish({ event: "message", id: this.messageId, role: "assistant", content });
      }
    }
    this.revisionId = 1;
  }

  /* --- segmentation --- */

  // Walk unconsumed text; emit segments at paragraph breaks and at sentence
  // boundaries past the minimum length. On final=true, flush the remainder.
  private chunkSegments(fullText: string, final: boolean) {
    let buffer = fullText.slice(this.consumed);
    for (; ;) {
      const cut = final ? null : this.findBoundary(buffer);
      if (cut === null) break;
      this.emitSegment(buffer.slice(0, cut));
      this.consumed += cut;
      buffer = fullText.slice(this.consumed);
    }
    if (final && buffer.trim()) {
      this.emitSegment(buffer);
      this.consumed += buffer.length;
    }
  }

  private findBoundary(buffer: string): number | null {
    const para = buffer.indexOf("\n\n");
    if (para >= 0 && buffer.slice(0, para).trim()) return para + 2;

    const sentence = /[.!?](?=\s)/g;
    let match: RegExpExecArray | null;
    while ((match = sentence.exec(buffer)) !== null) {
      const end = match.index + 1;
      if (end >= SEGMENT_MIN_CHARS) return end;
    }
    return null;
  }

  private emitSegment(raw: string) {
    const text = speakable(raw);
    // Unpronounceable fragments (bare punctuation) make TTS engines cry 500.
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    const index = this.segmentIndex++;
    const synthesizing = this.hub.anyAudioListener();
    this.audio.register(this.messageId, index, text, synthesizing);
    this.hub.publish({ event: "segment", message_id: this.messageId, index, text, synthesizing });
  }

}
