# Familiar Interface Gateway

Interaction ingress, delivery, and browser-terminal projection for Familiar.
Lifted out of the `subscriber` pi extension: the gateway owns **all** public
HTTP; the extension is a thin relay that forwards events here.

Binds `127.0.0.1:1692`. See `DESIGN.md` for the full protocol rationale.

## What it does

- **SSE firehose** (`GET /stream?audio=1`) — the assistant/user/tool/segment
  event stream for remote clients (Hearth), with history replay, a per-session
  epoch UUID, and 25s heartbeats. Ported faithfully from the old
  `subscriber/hub.ts`.
- **Egress ingest** (`POST /ingest`) — the pi extension POSTs one
  `IngestEnvelope` per event (publish / revise / lock / session). Localhost
  only; low-rate, so POST-per-event over a persistent socket (see DESIGN.md).
- **Ingress** (`POST /submit`, `POST /cancel`) — text/voice in. The gateway owns
  STT/TTS (`FAMILIAR_STT_URL` / `FAMILIAR_TTS_URL`); it transcribes takes and
  pushes ready-to-dispatch commands down `GET /relay` (SSE), which the pi
  extension subscribes to and enacts against the pi API.
- **Segment audio** (`GET /segments/:mid/:idx/audio`) — synthesized wav.
- **Browser terminal** (`GET /terminal`, `GET /`) — the restty WASM terminal
  bridged over a `/pty` WebSocket to a `node-pty` child that ATTACHES directly
  to the private Presence Runtime tmux target (`FAMILIAR_ATTACH_CMD` remains a
  test override). Replaces the Electron client's local-shell
  dance. Fonts + mouse + emoji-completer ported from the client renderer.

## Run

    cd services/gateway
    npm install          # builds node-pty (no Linux prebuild) + vendors assets
    npm start            # node --experimental-transform-types src/main.ts  →  http://127.0.0.1:1692

Node 22 runs the TypeScript directly. `--experimental-transform-types` (not
plain strip-only mode) is required because the code uses TS parameter
properties; no separate build step.

### Webfont

The Nix package generates a double-patched ProggyClean Nerd Font Mono: FontForge
copies missing glyphs in selected BMP text/symbol ranges from DejaVu Sans,
fits every imported outline to the ProggyClean cell, and preserves its mono
advance. The package installs that output over the base font asset. Repository
dev mode serves source assets, so run it through the top-level gateway shell
(`nix develop .#gateway -c npm --prefix services/gateway start`); the shell sets
`FAMILIAR_GATEWAY_PATCHED_FONT` to the same generated Nix output. Running npm
outside that shell deliberately falls back to the vendored base font.

### Environment

| var | default | meaning |
| --- | --- | --- |
| `FAMILIAR_SERVER_PORT` / `FAMILIAR_SUBSCRIBER_PORT` | `1692` | listen port |
| `FAMILIAR_SERVER_HOST` | `127.0.0.1` | listen host; non-loopback values are rejected by default |
| `FAMILIAR_GATEWAY_ALLOW_NONLOOPBACK` | — | Set exactly `1` to permit an unauthenticated non-loopback bind; startup emits a security warning. |
| `FAMILIAR_DROPS_DIR` | `${dirname(FAMILIAR_LOG_PATH)}/uploads`, otherwise a per-user temporary directory | Private upload storage. The gateway requires user ownership, refuses a symlink, and enforces directory/file modes `0700`/`0600`. |
| `FAMILIAR_ATTACH_CMD` | Presence controller `attach` | Test override for the browser PTY child. Set to `bash -l` to smoke-test without tmux. |
| `FAMILIAR_PRESENCE_CTL` | repository `services/presence/presence.sh` | Presence lifecycle controller path. |
| `FAMILIAR_ATTACH_CWD` | gateway cwd | working dir for the attach child |
| `FAMILIAR_STT_URL` / `FAMILIAR_TTS_URL` | — | dumb HTTP model endpoints |
| `FAMILIAR_TTS_VOICE` | — | optional TTS voice selection |
| `FAMILIAR_LOG_PATH` | stderr | JSONL sidecar log base (`${path}.${suffix}`) |
| `FAMILIAR_DEBUG_LEVEL` | `debug` | `off` \| `error` \| `debug` |

## Fronting (out of scope, noted for later)

The gateway has **no auth** — it binds localhost unless the operator explicitly
sets both a non-loopback `FAMILIAR_SERVER_HOST` and
`FAMILIAR_GATEWAY_ALLOW_NONLOOPBACK=1`. A remote deployment should put it behind
an authenticating reverse proxy at a configured hostname (for example,
`familiar.example.com`) and forward authenticated requests to
`127.0.0.1:1692`. The `/pty` and `/stream` WebSocket/SSE routes require the proxy
to pass `Upgrade`/`Connection` headers and disable buffering on SSE routes. None
of that lives here; this service assumes anything that reaches it is already
authorized.
