# Subscriber Extension — Design Spec

One pi extension. Lets remote clients (Hearth, future surfaces) attach to the
session for voice/text ingress and egress. All state in-process; models are
dumb HTTP endpoints (`FAMILIAR_STT_URL`, `FAMILIAR_TTS_URL`).

Prior art: hearth `BRIEF-VOICE.md`, `BRIEF-RELIABILITY.md`, `DONE-CHUNKS.md`.
Consult for rationale, not authority — experiential lessons only. The one
lesson that is law: **no global playout state; everything keyed per-stream.**

## Shape

- Extension opens one HTTP port (`FAMILIAR_SUBSCRIBER_PORT`) in `session_start`,
  closes it in `session_shutdown`. Idempotent. Never throw past a handler.
- Push for discovery (SSE), pull for payload (GET). Clients that die, sleep,
  or tunnel just re-attach and re-pull.

## Listeners

- `GET /events` — SSE. Attaching with `?audio=1` marks an audio listener.
- Synthesis decision: **at least one live audio listener at segment-creation
  time** → audio rendition advertised. No listeners → text only, TTS never
  invoked. (Replaces cranium's ingress-time disposition flag.)

## Egress

- Assistant output is chunked into segments (sentence-ish boundaries).
- SSE event per segment: `{stream_id, index, renditions: [text, audio?]}`.
  Event advertises existence; never carries bytes.
- `GET /streams/:id/segments/:n/text` — immediate.
- `GET /streams/:id/segments/:n/audio` — synthesize-on-request, cached after.
  404 = not yet (retry), 5xx = synth failed (skip, don't stall).
- Client-side (Hearth's proven recovery, keep all four, all per-stream):
  dedup via next-index per stream; barge-in suppression as a set of stream
  ids; generation counter checked before enqueue; SSE `since=` cursor with
  honest cursor-expired signal when the gap is unrecoverable.

## Ingress

- `POST /takes` → take id. `PUT /takes/:id/:seq` — numbered audio chunks,
  any order, resumable. `POST /takes/:id/done` → responds with missing seqs;
  client re-PUTs and re-POSTs done. 404/410 = take reaped, start over.
- On complete take: transcribe chunks via STT endpoint, stream partials into
  the editor (`setEditorText`), commit via `sendMessage` on final.
- Typed input during a voice take: no sequencing machinery. Dispatch as
  adjacent labeled inputs (`[spoken]` / `[typed]`); the model sorts it out.

## Non-goals (v1)

- No auth (localhost/tailnet only). No multi-session. No manifest polling
  endpoint. No token-level TTS streaming — segment granularity is the floor.
- No input-provenance tracking. Model provenance already lands in telemetry.

## Open questions (answer during build, not before)

- Does pi expose delta-level events for in-progress assistant text, or only
  `message_end`? Determines whether egress segments stream mid-turn or
  per-message. Segment-per-message is an acceptable floor.
- Take reap policy: timer, count, or session-shutdown only.
