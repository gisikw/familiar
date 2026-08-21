export const PROTOCOL_NAME = "familiar-client" as const;
export const CURRENT_PROTOCOL_VERSION = 1 as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

export type ProtocolVersion = 1;
export type StreamName = "control" | "terminal" | "interaction" | "voice" | "files" | "presence" | "worklist";
export interface ResumeCursor { stream: StreamName; sequence: number }
export interface BaseMessage<T extends string> { version: ProtocolVersion; type: T; stream: StreamName; sequence: number; requestId?: string }

export interface HelloMessage { version: 1; type: "hello"; protocol: typeof PROTOCOL_NAME; supportedVersions: number[]; client: { id: string; deviceId?: string; name?: string; capabilities?: string[] }; auth?: { scheme: "bearer"; token: string }; resume?: ResumeCursor[] }
export interface WelcomeMessage extends BaseMessage<"welcome"> { stream: "control"; selectedVersion: ProtocolVersion; connectionId: string; sessionId: string; resumed: boolean; replay: { cursors: ResumeCursor[]; truncatedStreams?: StreamName[] }; heartbeatMs?: number }
export interface AuthErrorMessage { version: 1; type: "auth.error"; code: "unauthorized" | "forbidden" | "version_mismatch"; message: string; supportedVersions?: number[] }

export interface TerminalAttach extends BaseMessage<"terminal.attach"> { stream: "terminal"; cols: number; rows: number }
export interface TerminalInput extends BaseMessage<"terminal.input"> { stream: "terminal"; data: string }
export interface TerminalResize extends BaseMessage<"terminal.resize"> { stream: "terminal"; cols: number; rows: number }
export interface TerminalOutput extends BaseMessage<"terminal.output"> { stream: "terminal"; data: string; encoding: "base64" | "utf8" }
export interface TerminalStatus extends BaseMessage<"terminal.status"> { stream: "terminal"; status: "attached" | "detached" | "exited"; code?: number }

export interface TextSubmit extends BaseMessage<"text.submit"> { stream: "interaction"; text: string; correlationId?: string }
export interface InteractionCancel extends BaseMessage<"interaction.cancel"> { stream: "interaction"; correlationId?: string }
export interface TranscriptMessage extends BaseMessage<"text.message"> { stream: "interaction"; messageId: string; role: "user" | "assistant"; text: string; revision?: number; final: boolean; createdAt?: string; correlationId?: string }
export interface ToolStatus extends BaseMessage<"tool.status"> { stream: "interaction"; toolCallId: string; name: string; args?: string; status: "running" | "complete" | "failed" }

export interface VoiceChunk extends BaseMessage<"voice.chunk"> { stream: "voice"; takeId: string; chunk: number; data: string; encoding: "base64"; final?: boolean; chunkCount?: number; typedText?: string; mediaType?: string }
export interface VoiceTranscript extends BaseMessage<"voice.transcript"> { stream: "voice"; takeId: string; text: string; final: boolean }
export interface TtsSegment extends BaseMessage<"voice.tts.segment"> { stream: "voice"; messageId: string; segment: number; text?: string; status: "pending" | "ready" | "failed"; audioUrl?: string }

export interface FileOffer extends BaseMessage<"file.offer"> { stream: "files"; uploadId: string; name: string; size: number; mediaType?: string }
export interface FileChunk extends BaseMessage<"file.chunk"> { stream: "files"; uploadId: string; chunk: number; data: string; encoding: "base64"; final?: boolean }
export interface FileResult extends BaseMessage<"file.result"> { stream: "files"; uploadId: string; ok: boolean; path?: string; notified?: boolean; error?: string }

export interface PresenceStatus extends BaseMessage<"presence.status"> { stream: "presence"; sessionId: string; state: "starting" | "ready" | "busy" | "degraded" | "offline"; capabilities?: string[]; detail?: string }
export interface WorklistNotification extends BaseMessage<"worklist.notification"> { stream: "worklist"; id: string; priority: 0 | 1 | 2 | 3; kind: "notify" | "question" | "review"; summary: string; body?: string; attention: "open" | "available" | "focused" | "protected"; createdAt: string }
export interface AttentionStatus extends BaseMessage<"attention.status"> { stream: "worklist"; level: "open" | "available" | "focused" | "protected"; expiresAt?: string; queued?: number }
export interface ErrorEnvelope extends BaseMessage<"error"> { stream: StreamName; code: string; message: string; retryable: boolean; details?: Record<string, unknown> }
export interface AckMessage extends BaseMessage<"ack"> { stream: StreamName; acknowledgedSequence: number }

export type ClientMessage = HelloMessage | TerminalAttach | TerminalInput | TerminalResize | TextSubmit | InteractionCancel | VoiceChunk | FileOffer | FileChunk | AckMessage;
export type ServerMessage = WelcomeMessage | AuthErrorMessage | TerminalOutput | TerminalStatus | TranscriptMessage | ToolStatus | VoiceTranscript | TtsSegment | FileResult | PresenceStatus | WorklistNotification | AttentionStatus | ErrorEnvelope | AckMessage;
export type ProtocolMessage = ClientMessage | ServerMessage;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Obj, k: string, e: string[], optional = false) => { if (!(k in o) && optional) return; if (typeof o[k] !== "string") e.push(`${k} must be a string`); };
const num = (o: Obj, k: string, e: string[], optional = false) => { if (!(k in o) && optional) return; if (!Number.isSafeInteger(o[k]) || Number(o[k]) < 0) e.push(`${k} must be a non-negative safe integer`); };
const bool = (o: Obj, k: string, e: string[], optional = false) => { if (!(k in o) && optional) return; if (typeof o[k] !== "boolean") e.push(`${k} must be a boolean`); };
const one = (o: Obj, k: string, values: readonly unknown[], e: string[]) => { if (!values.includes(o[k])) e.push(`${k} must be one of ${values.join(", ")}`); };
const streams: StreamName[] = ["control", "terminal", "interaction", "voice", "files", "presence", "worklist"];

function common(o: Obj, e: string[]) {
  if (o.version !== 1) e.push("version must be 1");
  str(o, "type", e); one(o, "stream", streams, e); num(o, "sequence", e); str(o, "requestId", e, true);
}
function validateHello(o: Obj, e: string[]) {
  if (o.version !== 1) e.push("version must be 1");
  if (o.protocol !== PROTOCOL_NAME) e.push(`protocol must be ${PROTOCOL_NAME}`);
  if (!Array.isArray(o.supportedVersions) || !o.supportedVersions.every(Number.isSafeInteger)) e.push("supportedVersions must be an integer array");
  if (!object(o.client)) e.push("client must be an object"); else str(o.client, "id", e);
  if (o.auth !== undefined && (!object(o.auth) || o.auth.scheme !== "bearer" || typeof o.auth.token !== "string" || !o.auth.token)) e.push("auth must be a non-empty bearer credential");
  if (o.resume !== undefined && (!Array.isArray(o.resume) || !o.resume.every(c => object(c) && streams.includes(c.stream as StreamName) && Number.isSafeInteger(c.sequence) && Number(c.sequence) >= 0))) e.push("resume must contain valid stream cursors");
}

const validators: Record<string, (o: Obj, e: string[]) => void> = {
  welcome(o,e){ common(o,e); one(o,"stream",["control"],e); num(o,"selectedVersion",e); str(o,"connectionId",e); str(o,"sessionId",e); bool(o,"resumed",e); if(!object(o.replay)) e.push("replay must be an object"); },
  "auth.error"(o,e){ if(o.version!==1)e.push("version must be 1"); one(o,"code",["unauthorized","forbidden","version_mismatch"],e); str(o,"message",e); },
  "terminal.attach"(o,e){ common(o,e); one(o,"stream",["terminal"],e); num(o,"cols",e); num(o,"rows",e); },
  "terminal.input"(o,e){ common(o,e); one(o,"stream",["terminal"],e); str(o,"data",e); },
  "terminal.resize"(o,e){ common(o,e); one(o,"stream",["terminal"],e); num(o,"cols",e); num(o,"rows",e); },
  "terminal.output"(o,e){ common(o,e); one(o,"stream",["terminal"],e); str(o,"data",e); one(o,"encoding",["base64","utf8"],e); },
  "terminal.status"(o,e){ common(o,e); one(o,"stream",["terminal"],e); one(o,"status",["attached","detached","exited"],e); },
  "text.submit"(o,e){ common(o,e); one(o,"stream",["interaction"],e); str(o,"text",e); },
  "interaction.cancel"(o,e){ common(o,e); one(o,"stream",["interaction"],e); },
  "text.message"(o,e){ common(o,e); one(o,"stream",["interaction"],e); str(o,"messageId",e); one(o,"role",["user","assistant"],e); str(o,"text",e); bool(o,"final",e); },
  "tool.status"(o,e){ common(o,e); one(o,"stream",["interaction"],e); str(o,"toolCallId",e); str(o,"name",e); one(o,"status",["running","complete","failed"],e); },
  "voice.chunk"(o,e){ common(o,e); one(o,"stream",["voice"],e); str(o,"takeId",e); num(o,"chunk",e); str(o,"data",e); one(o,"encoding",["base64"],e); },
  "voice.transcript"(o,e){ common(o,e); one(o,"stream",["voice"],e); str(o,"takeId",e); str(o,"text",e); bool(o,"final",e); },
  "voice.tts.segment"(o,e){ common(o,e); one(o,"stream",["voice"],e); str(o,"messageId",e); num(o,"segment",e); one(o,"status",["pending","ready","failed"],e); },
  "file.offer"(o,e){ common(o,e); one(o,"stream",["files"],e); str(o,"uploadId",e); str(o,"name",e); num(o,"size",e); },
  "file.chunk"(o,e){ common(o,e); one(o,"stream",["files"],e); str(o,"uploadId",e); num(o,"chunk",e); str(o,"data",e); one(o,"encoding",["base64"],e); },
  "file.result"(o,e){ common(o,e); one(o,"stream",["files"],e); str(o,"uploadId",e); bool(o,"ok",e); },
  "presence.status"(o,e){ common(o,e); one(o,"stream",["presence"],e); str(o,"sessionId",e); one(o,"state",["starting","ready","busy","degraded","offline"],e); },
  "worklist.notification"(o,e){ common(o,e); one(o,"stream",["worklist"],e); str(o,"id",e); one(o,"priority",[0,1,2,3],e); one(o,"kind",["notify","question","review"],e); str(o,"summary",e); one(o,"attention",["open","available","focused","protected"],e); str(o,"createdAt",e); },
  "attention.status"(o,e){ common(o,e); one(o,"stream",["worklist"],e); one(o,"level",["open","available","focused","protected"],e); },
  error(o,e){ common(o,e); str(o,"code",e); str(o,"message",e); bool(o,"retryable",e); },
  ack(o,e){ common(o,e); num(o,"acknowledgedSequence",e); },
};

export function validateMessage(value: unknown): ValidationResult<ProtocolMessage> {
  if (!object(value)) return { ok: false, errors: ["message must be an object"] };
  const errors: string[] = [];
  if (value.type === "hello") validateHello(value, errors);
  else if (typeof value.type !== "string" || !validators[value.type]) errors.push("unknown message type");
  else validators[value.type](value, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: value as unknown as ProtocolMessage };
}
export function parseMessage(json: string): ValidationResult<ProtocolMessage> { try { return validateMessage(JSON.parse(json)); } catch { return { ok: false, errors: ["invalid JSON"] }; } }
export function negotiateVersion(offered: readonly number[]): ProtocolVersion | null { return offered.includes(CURRENT_PROTOCOL_VERSION) ? CURRENT_PROTOCOL_VERSION : null; }

// Incremental-adoption validators for the gateway's current HTTP/SSE shapes.
export type LegacySubmitPayload = { type: "text"; content: string; id?: number } | { type: "audio"; id: number; seq: number; data: string; segments: number; text?: string };
export function validateLegacySubmit(value: unknown): ValidationResult<LegacySubmitPayload> {
  if (!object(value)) return { ok:false, errors:["payload must be an object"] };
  const errors:string[]=[];
  if(value.type==="text"){ str(value,"content",errors); num(value,"id",errors,true); }
  else if(value.type==="audio"){ num(value,"id",errors); num(value,"seq",errors); str(value,"data",errors); num(value,"segments",errors); str(value,"text",errors,true); }
  else errors.push("type must be text or audio");
  return errors.length?{ok:false,errors}:{ok:true,value:value as LegacySubmitPayload};
}
