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
  bridged over a `/pty` WebSocket to a per-client `node-pty` child running
  `familiar-viewer` directly. Each native viewer embeds the private Presence
  Runtime tmux target and owns its sidebar and target switching
  (`FAMILIAR_ATTACH_CMD` remains a test override). Closing the WebSocket reaps
  that viewer process without affecting Presence or workers. Replaces the
  Electron client's local-shell dance. Fonts + mouse + emoji-completer ported
  from the client renderer.

## Hearth stream decoding

`GET /stream` remains the compatible SSE endpoint: each non-comment frame has
one JSON object on its `data:` line. An attach is also the authoritative
snapshot. Frames arrive in this exact order:

1. `{"event":"session","id":"<uuid>"}`;
2. the retained locked-event history, in production order;
3. when an assistant message is mutable, its latest complete `message` revision.

A changed session `id` resets the message-id namespace, so Hearth must discard
its old projection before applying the following snapshot. Within one session,
decode these fields as follows:

- `message.id` is the transcript key. A present `message.revision` marks a
  mutable value and a higher revision **replaces the whole prior value**. A
  message with no `revision` is locked and replaces any draft with the same id.
- For an assistant message, a present `message.parts` is authoritative and is
  replaced as a whole, not delta-applied. Each ordered part is exactly one of
  `{"type":"text","text":string}` or
  `{"type":"tool","id":string,"name":string,"args":string}`. Concatenating
  the `text` fields produces legacy `message.content`. `args` is a JSON string
  when serialization succeeds, not an embedded JSON value, and is capped at
  300 characters plus `…`.
- If `message.parts` is absent (an older Familiar producer), fall back to one
  text part containing `message.content`.
- A live `tool` event has `id`, `name`, `args`, and additive `message_id`.
  Upsert it by tool `id` under that assistant message; do not duplicate a tool
  already present in authoritative `message.parts`. Producers predating this
  extension may omit `message_id`, in which case it remains display-only
  liveness as before.

Thus a client attaching between tool calls receives all retained completed
messages/tools and the latest already-produced text/tool parts of the mutable
assistant message. Familiar folds a tool that races an attach into that latest
revision. The snapshot is deliberately bounded to the current in-memory
session: at most 500 locked events, one full mutable message, and 300 characters
of arguments per tool. Existing `session`, `message`, and `tool` discriminators
and all old fields retain their meanings; the new fields are additive.

## Context saturation wire telemetry

`GET /stream` exposes Pi's context-window pressure without changing any existing
event or field. The value is a JSON number in the closed `0...1` interval (not
a `0...100` percentage):

```json
{"event":"saturation","saturation":0.625}
```

The subscriber emits this event after each `turn_end`, using Pi's
`ctx.getContextUsage()` after the assistant usage has been committed. The ratio
is `tokens / contextWindow`, clamped to `0...1`. If that API is unavailable or
has no token value, the compatibility fallback uses the completed assistant's
provider token usage (`totalTokens`, or input + output + cacheRead + cacheWrite)
divided by the active `model.contextWindow`; it never estimates from message
text. If neither
a direct measurement nor valid completed-turn usage exists (for example after
compaction but before a successful response), no event is emitted. The attach
snapshot continues to mean “latest known measurement,” never a fabricated one.

Saturation is replaceable telemetry, not transcript history. The gateway keeps
only the latest value for the current Pi session and adds it to the first
attach frame:

```json
{"event":"session","id":"<uuid>","saturation":0.625}
```

That `session` frame remains first, before locked-history replay and any
in-flight message. `saturation` is absent until Pi has supplied a measurement,
and a new Pi session clears it. While attached, clients apply each live
`saturation` event as a whole-value replacement. On reconnect they initialize
the same value from `session.saturation`. This maps directly to Hearth's
`MawRoomAttach.saturation` and `MawLiveEvent.saturation` paths. Older clients
remain compatible because the session field and event discriminator are
additive; clients that do not recognize them can ignore them.

## Run

    cd services/gateway
    npm install          # builds node-pty (no Linux prebuild) + vendors assets
    npm start            # node --experimental-transform-types src/main.ts  →  http://127.0.0.1:1692

Node 22 runs the TypeScript directly. `--experimental-transform-types` (not
plain strip-only mode) is required because the code uses TS parameter
properties; no separate build step.

### Browser attach lifecycle and geometry

At boot the gateway runs `presence.sh ensure` once (unless the test override is
active), because `familiar-viewer` deliberately does not create the resident
Presence session. A synchronous PTY spawn failure triggers one more ensure and
one retry. `familiar.sh` exports `FAMILIAR_PRESENCE_SOCKET`; plugin navigation
and exact terminal targets are passed through Familiar's render host environment.

The first restty resize supplies node-pty's initial `cols`/`rows`. Later
WebSocket resize messages call `node-pty.resize`; the resulting SIGWINCH is read
by crossterm as `Resize`, and the viewer resizes its embedded portable-pty.

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
| `FAMILIAR_VIEWER_BIN` | `familiar-viewer` from `PATH` (Nix wrapper: packaged viewer store path) | Native browser PTY child executable. |
| `FAMILIAR_ATTACH_CMD` | — | Highest-priority test override for the browser PTY child. Set to `bash -l` to smoke-test without tmux. |
| `FAMILIAR_PRESENCE_CTL` | repository `services/presence/presence.sh` | Presence lifecycle controller used for `ensure`, not browser attachment. |
| `FAMILIAR_ATTACH_CWD` | gateway cwd | working dir for the attach child |
| `FAMILIAR_PRESENCE_SOCKET` | `${FAMILIAR_PRESENCE_STATE_DIR:-<repo>/state/presence}/tmux.sock` | Inner Presence tmux socket passed through to the viewer. |
| `FAMILIAR_RENDER_URL` | — | Optional Familiar-owned semantic `left-nav` endpoint passed to each viewer. |
| `FAMILIAR_STT_URL` / `FAMILIAR_TTS_URL` | — | HTTP model base URLs; gateway calls `/v1/audio/transcriptions` and `/v1/audio/speech` respectively |
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
