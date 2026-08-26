# Familiar client protocol v1

This is the public application boundary between Familiar clients and the Interface Gateway. It is JSON-compatible and transport-neutral (WebSocket is expected; HTTP/SSE and local IPC may map the same messages). Pi protocol, tmux names, and presence-adapter details never cross this boundary.

## Envelope and sequencing

Except `hello` and pre-connection `auth.error`, every message has `version: 1`, a dotted `type`, `stream`, and a non-negative monotonic `sequence`. Sequences are independent per stream and per sender, start at 0, and never repeat within a gateway session epoch. `requestId` optionally correlates command results. Binary bytes are base64 until a transport negotiates a binary mapping.

Streams are `control`, `terminal`, `interaction`, `voice`, `files`, `presence`, and `worklist`. Unknown fields must be ignored. Unknown message types must be rejected with an `error` message; this permits additive fields while protecting semantics.

## Handshake and authentication

The first client message is `hello`: protocol name `familiar-client`, descending `supportedVersions`, stable client/device identity, optional capability strings, optional bearer credential, and optional resume cursors. The gateway selects the highest mutually supported version (v1 currently) and replies `welcome`, containing connection/session epoch IDs, whether replay succeeded, resulting cursors, truncated streams, and optional heartbeat interval. Failure before a connection is established uses `auth.error` (`unauthorized`, `forbidden`, or `version_mismatch`). Tokens must not be logged.

Version selection is explicit. Add optional fields/message types within a version; change meaning, required fields, ordering, or encoding only in a new version. Servers retain at least the previous deployed version during migrations.

## Reconnect and replay

A client persists the greatest fully applied sequence per stream and sends those cursors in its next `hello`. The gateway replays events strictly after each cursor in stream order. Streams may interleave; no ordering exists across streams. Duplicate or older sequence values are ignored by clients. Gaps cause reconnect/resume rather than speculative application. `welcome.replay.truncatedStreams` means retained history cannot satisfy a cursor: discard that stream's projection and rebuild from the replay/snapshot. A changed `sessionId` resets session-scoped interaction and terminal projections, matching today's gateway session epoch behavior. File uploads and commands are not implicitly retried; clients use stable IDs and server acknowledgements. `ack` reports the greatest contiguous applied sequence and permits bounded replay eviction.

## Messages

### Control
- `hello` — client/version/auth/capabilities/resume request.
- `welcome` — selected version, epoch, replay result.
- `auth.error` — handshake failure without leaking credential details.
- `ack` — contiguous receive cursor for the named stream.
- `error` — code, safe message, retryability, optional non-secret details. `requestId` associates it with a command.

### Terminal
- `terminal.attach` — request projection at `cols` × `rows`.
- `terminal.input` — UTF-8 terminal input.
- `terminal.resize` — update geometry.
- `terminal.output` — PTY output (`utf8` or base64).
- `terminal.status` — attached/detached/exited, with optional exit code.

These formalize the current `/pty` input/resize, binary output, status/error/exit frames without exposing the tmux-backed adapter.

### Text interaction
- `text.submit` — user text and optional stable correlation ID.
- `interaction.cancel` — idempotent cancellation.
- `text.message` — user/assistant projection; revisions replace the same `messageId`; `final` locks it.
- `tool.status` — bounded tool-call liveness, not tool results.

### Voice
- `voice.chunk` — ordered base64 audio chunks for a stable `takeId`; final chunk may state total count and adjacent typed text.
- `voice.transcript` — STT text, provisional or final.
- `voice.tts.segment` — synthesis lifecycle and, when ready, an audio URL.

This maps today's chunked `/submit` audio, STT dispatch, segment events, and `/segments/:message/:segment/audio` endpoint.

### Files
- `file.offer` — metadata and declared size.
- `file.chunk` — ordered base64 file data.
- `file.result` — stored path, notification result, or safe failure. Upload IDs make client retries deduplicable.

This coexists with today's raw/multipart `/upload`; the Gateway can translate either surface.

### Presence and worklist
- `presence.status` — epoch and starting/ready/busy/degraded/offline state plus capability names.
- `worklist.notification` — referable priority 0–3 notification/question/review and current attention state.
- `attention.status` — open/available/focused/protected state, optional expiry and queued count.

## Incremental adoption

`validateLegacySubmit` validates the existing `/submit` text/audio body. Gateways may first import legacy validators, then translate existing SSE/PTTY/upload traffic into v1 at a new endpoint. Existing endpoints remain valid during migration; no flag-day protocol replacement is required.
