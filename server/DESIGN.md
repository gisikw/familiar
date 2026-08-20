# familiar server — design notes

Standalone web presence lifted out of the `subscriber` pi extension. Binds
`127.0.0.1:1692`. No auth in-process (localhost only; fronted by nginx/Pocket
ID at familiar.gisi.network later — see README).

## Runtime

Node 22 (`node src/main.ts` — native type-stripping, no build step). Deps kept
minimal: `ws` (WebSocket server for the terminal bridge) and `node-pty` (PTY
allocation for the herdr attach; node-pty 1.1.0 ships no Linux prebuild, so
`npm install` compiles it via bundled node-gyp — the same toolchain the
Electron client already relies on). Everything else uses node built-ins
(`http`, global `fetch`).

Node — not bun — because node-pty needs a native compile and npm bundles
node-gyp; bun's installer can't build it. A node-gyp-built `pty.node` loads
under bun too, but standardising on node keeps one toolchain.

## Channels between extension (pi) and server

Egress (pi → server), the documented ingest path:

    POST /ingest        body: StreamEvent JSON (or {event:"__session"})

One POST per event. **Justification for POST-per-event over a persistent
socket:** events are low-rate (assistant message revisions, tool starts,
segment boundaries — human-conversational cadence, not a byte stream), the
link is loopback (no TCP-setup cost worth avoiding), and a stateless POST is
trivially curl-testable and trivially degradable — the relay drops into a
small bounded queue when the server is down and flushes on the next success,
never throwing into pi. A persistent socket would add reconnect/backpressure
machinery for no throughput benefit at this rate.

Ingress (server → pi), for the two things that must touch the pi API
(`sendUserMessage`, `ctx.abort`):

    GET /relay          SSE stream of commands: {type:"submit"|"cancel", ...}

The extension subscribes once. STT/TTS are dumb HTTP endpoints the *server*
owns (FAMILIAR_STT_URL / FAMILIAR_TTS_URL), so transcription and synthesis
live server-side; the server assembles a ready-to-dispatch submit and pushes
it down /relay, where the extension echoes it for correlation and calls
`pi.sendUserMessage`. `/cancel` pushes a cancel command → `ctx.abort()`.

Session epoch: the server mints a UUID per process AND re-mints + clears
history when the extension announces a new pi session (`{event:"__session"}`
on session_start). This preserves the original "changed epoch = message-id
space reset, drop cached transcript" contract even though history now lives in
the server: the id-space is owned by the extension's firehose, which restarts
with the pi session.

## HTTP surface (all owned by the server)

- `GET  /stream?audio=1`          SSE firehose (hub): session event, history
                                  replay, inflight revision, 25s heartbeat.
- `POST /ingest`                  egress from the extension.
- `POST /submit` / `POST /cancel` ingress (→ /relay → pi).
- `GET  /relay`                   server→extension command SSE.
- `GET  /segments/:mid/:idx/audio` synthesized wav (202/200/404/503).
- `GET  /terminal`, `GET /`       browser terminal page.
- `GET  /pty`  (WebSocket)        restty PTY protocol bridged to node-pty
                                  running FAMILIAR_ATTACH_CMD.
- static: `/vendor/restty.esm.js`, `/app/*.js`, `/fonts/*`, `/vendor/emoji.json`.

## Browser terminal

Serves the restty WASM terminal (vendored esm bundle, same as the Electron
renderer). A `/pty` WebSocket bridges restty's built-in WebSocket PTY
transport to a node-pty child running `FAMILIAR_ATTACH_CMD` (default
`herdr session attach familiar`) — attaching to the already-running herdr
session, never booting a second familiar.sh. Resize is the restty protocol
(`{type:"resize",cols,rows}`); data path is binary-safe (output framed as
binary, input as the protocol's `{type:"input",data}`). Renderer niceties
ported from client/src/renderer: in-memory font array (ProggyClean NF primary
+ JetBrains Mono + OpenMoji cmap entry name:"OpenMoji"), SGR mouse synthesis
(mouse.js), emoji completer (emoji.js).
