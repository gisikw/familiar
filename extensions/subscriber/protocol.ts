/* The protocol now lives with the server (server/src/protocol.ts), which owns
 * all HTTP. This shim re-exports the pieces the extension still needs so the
 * relay/firehose imports stay put and there is a single source of truth for
 * the wire types shared across the extension⇄server boundary. */
export {
  INGRESS_DISPOSITION,
  PRIVATE_TYPES,
  TOOL_ARGS_MAX,
  HISTORY_MAX,
  PENDING_ECHO_MAX,
  RELAY_QUEUE_MAX,
  SEGMENT_MIN_CHARS,
} from "../../server/src/protocol.ts";

export type {
  SessionEvent,
  MessageEvent,
  ToolEvent,
  SegmentEvent,
  SegmentAudioEvent,
  StreamEvent,
  IngestEnvelope,
  SubmitCommand,
  CancelCommand,
  RelayCommand,
  SubmitPayload,
} from "../../server/src/protocol.ts";
