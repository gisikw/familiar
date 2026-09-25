# Gateway design

The gateway is a localhost HTTP boundary between Pi processes and user-facing
clients. Pi extensions own Pi APIs; the gateway owns transport, replay, voice
models, upload storage, and browser PTYs.

## Session-addressed channels

A Pi session id (`FAMILIAR_INSTANCE_ID`) is the routing identity. The subscriber
adds this identity, `role` (`primary` or `fork`), and a fork's
`parentSessionId` to every `/ingest` envelope and `/relay` subscription.
The gateway stores a `Map<sessionId, Channel>`. Each channel owns its own:

- `StreamHub` epoch, bounded history, mutable message, saturation, and agent state;
- `RelayBus` subscriber set;
- `Ingress` voice take buffers and sequencing; and
- `AudioCache` and synthesis queue.

Consequently, a `session` ingest envelope clears only that channel and a relay
command is delivered only to that channel's Pi. The gateway retains a channel
for ten minutes after its final relay subscriber disconnects, permitting short
restarts to replay history, then closes and removes it.

`/stream`, `/relay`, `/agent`, `/submit`, `/cancel`, `/voice-status`, `/upload`,
`/segments/:message/:index/audio`, and `/pty` accept `?session=<id>`. An omitted
parameter resolves to the most recently registered primary channel. A
provisional primary channel preserves the historical startup behavior when a
client connects before Pi; the first primary registration adopts that channel.

The extension's `/relay` request additionally carries `role` and optional
`parentSessionId`, allowing it to register before the first ingest POST. These
parameters are extension metadata, not needed by ordinary clients.

## Discovery

`GET /sessions` merges live channels with
`$FAMILIAR_STATE_DIR/forks/*/fork.json`. Results contain `id`, `role`,
`parentSessionId`, `task`, `state`, `startedAt`, and `lastEventAt`. Fork session
JSONL files are cached by mtime and size. Marker order determines terminal
state: a pending marker newer than the latest sent marker is `merging`; a sent
marker is `merged`; otherwise an attached relay is `live`, and the fork is
`stopped`.

Discovery does not start services and does not mutate fork state.

## PTY selection

No-session `/pty` keeps the primary Presence resolution contract
(`FAMILIAR_PRESENCE_SOCKET`, then `FAMILIAR_PRESENCE_STATE_DIR`). An explicitly
selected fork uses
`$FAMILIAR_STATE_DIR/forks/<uuid>/presence/tmux.sock`. Before WebSocket upgrade,
the gateway requires a UUID-shaped id and an existing fork directory. The
selected socket is passed only to that viewer child. Presence lifecycle remains
owned by systemd.

## Compatibility and failure behavior

Public clients need not know session ids: omission continues to target the
primary. Stream epoch UUIDs remain separate from routing ids so a Pi process
restart can force clients to discard a stale message-id projection even when it
reopens the same persisted Pi session.

Ingest is intentionally POST-per-event over localhost. The extension keeps a
small bounded retry queue, while `/relay` is an SSE stream with reconnect. A
command with no attached Pi is dropped rather than queued into a later turn.
There is no gateway authentication; non-loopback binding requires the explicit
unsafe opt-in documented in the README.
