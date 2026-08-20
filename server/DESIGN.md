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

### App-mouse wiring (why a custom transport)

The app-mouse layer (mouse.js) needs two things restty 0.2.6 does **not**
expose as public methods on the `Restty` class:

1. the raw pty **output** stream, to watch DECSET `1000/1002/1003/1006` toggles
   and know when the remote app (herdr sidebar, pi, vim, …) wants mouse
   reports and in which encoding; and
2. the live **grid geometry** (cols/rows) to map pointer px → terminal cell.

The Electron renderer gets both by owning a custom `ptyTransport` (IPC-backed)
whose `connect()` wraps `onData` (→ `decset.feed`) and whose `resize()` tracks
geometry. An earlier served version instead used restty's **built-in** ws
transport and tried `restty.onOutput(…)` / `restty.getGridSize()` — **neither
method exists**, so the optional-chained calls silently no-op'd: `decset` was
never fed, `isActive()` was always `false`, every pointer handler early-
returned, and mouse was completely dead (no clicks, no drag; selection also
felt broken because the handlers still captured some events).

Fix: the served page now wraps restty's exported `createWebSocketPtyTransport`
in a thin tap (`createTappedWsTransport` in web/terminal.js) that feeds output
to the DECSET tracker + latency probe and records geometry on resize — exactly
the Electron shape, but over WS instead of IPC. When tracking is **off**, the
pointer handlers early-return and restty's native selection works.

### Output coalescing & latency

node-pty emits many small chunks per redraw tick. `pty.ts` coalesces chunks
that arrive in the same event-loop tick and flushes once via `setImmediate`
(`FAMILIAR_PTY_FLUSH_MS` unset/0). This merges redraw bursts into one binary
WS frame while adding ~0ms to an isolated keystroke echo. A fixed flush *timer*
was measured to add its full interval to echo (loopback: p50 ~7.2ms at
FLUSH_MS=6 vs ~0.85ms with setImmediate), so timer-batching is opt-in only
(`FAMILIAR_PTY_FLUSH_MS>0`). restty already schedules its own paints off the
WASM core's frame loop, so no extra client-side rAF batching was needed.

A keystroke→echo probe lives in web/terminal.js (`?probe=1` auto-runs;
`window.__familiarProbe(n)` on demand) and scripts/probe-smoke.mjs (headless).
It types a unique token through the input path and times until the token's
bytes return on pty output, reporting p50/p95.

### Is the perceived lag inherent to the server-side design?

**No — not inherently.** In BOTH the browser and the Electron client the
keystroke echo crosses the *same* network to the *same* host and renders
locally:

- Electron: keystroke → local node-pty → (Kevin's own `ssh`) → NixOS host →
  shell echo → back over ssh → restty render. The pty is local; the wire hop
  is ssh.
- Browser: keystroke → WS frame → nginx (TLS, familiar.gisi.network) →
  `127.0.0.1:1692` → node-pty attach → shell echo → coalesced WS frame back →
  restty render. The pty is on the server; the wire hop is WS/TLS.

Both pay ~one host RTT for echo, so the **inherent transport delta is ~zero**.
Measured loopback baseline (no network, setImmediate coalescing, plain bash
attach): **keystroke→echo p50 ≈ 0.85ms, p95 ≈ 1.6ms** over 30 samples. That is
the server-path floor; it is not the source of perceptible lag.

Real-world differences come from three non-inherent sources, in likely order:

1. **Frame batching / paint scheduling** — the pre-fix code sent one WS frame
   per node-pty chunk and (worse) the mouse tap was dead. Coalescing fixes the
   frame-count amplification on redraws. *(addressed)*
2. **Browser tab throttling / resource contention** — a backgrounded or
   occluded tab has its timers/rAF throttled by the browser; WebGL/WebGPU
   paints can also stall under GPU contention. This is measurable: run
   `__familiarProbe(30)` foreground vs backgrounded and compare p95. Electron
   (a dedicated always-foreground window) doesn't suffer this. *(measure)*
3. **Proxy / tunnel hops** — Kevin reaches the server as `familiar.gisi.network`
   via **nginx on the NixOS host terminating TLS and `proxy_pass` to
   `127.0.0.1:1692`** (confirmed in repo state notes). If he reaches it from
   his Mac, the path is Mac → (internet/VPN) → nginx → loopback — one WAN RTT,
   the same order as his Electron ssh RTT. But **any extra port-forward or
   double-proxy hop** (e.g. an SSH `-L` tunnel *plus* nginx, or a slow TLS
   renegotiation) would add RTT the Electron ssh path doesn't have, and nginx
   `proxy_buffering`/lack of `proxy_read_timeout` tuning on the `/pty` upgrade
   can add jitter. **Verify nginx has `proxy_buffering off;` and WebSocket
   `Upgrade` headers on the `/pty` location**, and that there is no second
   tunnel hop in front of it. *(verify deployment)*

Bottom line: the server design is not inherently laggier than Electron. The
largest fixed win was the dead-mouse wiring (unrelated to lag but was the
headline breakage); the coalescing removes frame-count amplification; any
remaining perceptible lag should be chased in the browser (tab-throttle probe)
and the nginx `/pty` proxy config, not in the pty-on-server architecture.
