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
- **Optional fleet registry** (`POST/GET /fleet`, `DELETE /fleet/:node_id`) —
  durable enrollment and server-side reverse-port allocation, with generated
  OpenSSH/Herdr reconciliation inputs. It is disabled unless its complete
  configuration is supplied.

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

## Fleet registry and enrollment

Fleet enrollment is opt-in. Set all required values before starting the gateway:

| var | default | meaning |
| --- | --- | --- |
| `FAMILIAR_FLEET_STATE_DIR` | disabled | Private durable registry and generated-artifact directory. |
| `FAMILIAR_FLEET_PORT_MIN` / `FAMILIAR_FLEET_PORT_MAX` | `22000` / `22999` | Inclusive reverse-listen allocation range. |
| `FAMILIAR_FLEET_TUNNEL_HOST` | required | Rendezvous hostname returned to enrolled nodes. |
| `FAMILIAR_FLEET_TUNNEL_SSH_PORT` | `22` | Rendezvous sshd port. This is not a per-node reverse port. |
| `FAMILIAR_FLEET_TUNNEL_USER` | required | Restricted account used only to establish tunnels. |
| `FAMILIAR_FLEET_CONTROLLER_PUBLIC_KEY` | required | Ed25519 public key used by Familiar to reach node SSH endpoints. |
| `FAMILIAR_FLEET_TUNNEL_HOST_KEY` | required | Ed25519 host public key for fail-closed rendezvous pinning by clients. |
| `FAMILIAR_FLEET_CONTROLLER_IDENTITY_FILE` | — | Absolute private-key path written only into the local generated SSH route. Its contents never enter registry state or API responses. |
| `FAMILIAR_FLEET_FORCED_COMMAND` | `/bin/false` | Forced command in generated tunnel authorization. Must terminate any attempted session while allowing `ssh -N` forwarding. |
| `FAMILIAR_FLEET_PRESENCE_PATH` | — | Optional external, atomically replaced JSON presence projection; see below. |

`POST /fleet` accepts exactly:

```json
{
  "host": "asgmacbook",
  "tunnel_public_key": "ssh-ed25519 ...",
  "ssh_host_public_key": "ssh-ed25519 ...",
  "ssh_user": "local-user"
}
```

Both keys must be structurally valid Ed25519 public keys. Labels are canonicalized
to lowercase DNS labels. A successful response is:

```json
{
  "node_id": "fn_...",
  "host": "asgmacbook",
  "port": 22000,
  "tunnel_host": "fleet.example.com",
  "tunnel_ssh_port": 22,
  "tunnel_user": "familiar-tunnel",
  "remote_session": "familiar-fleet",
  "controller_public_key": "ssh-ed25519 ...",
  "tunnel_host_key": "ssh-ed25519 ..."
}
```

No API accepts or returns private key material. Repeating the identical request
for an active tunnel key returns the same node ID and port. Reusing that key
with changed attributes, or reusing an active label, is a conflict. Revoked key
identities remain tombstoned and cannot silently re-enroll. Range exhaustion is
a `503`; validation is `400`; conflicts are `409`; revoked identities are `410`.

`GET /fleet` returns `{"nodes":[...]}` for active identities. Each node includes
`enrolled_at` and a separate `presence` object. Presence defaults to
`{"state":"unknown","observed_at":null}` and never controls identity, routes,
or allocation. A tunnel monitor may atomically replace the configured presence
file with an object keyed by node ID whose values have `state` (`online`,
`offline`, or `unknown`) and `observed_at`. Tunnel loss therefore does not remove
anything. `DELETE /fleet/:node_id` is the explicit idempotent revocation operation;
it removes authorization/routes and releases the port while retaining the
identity tombstone.

### Deployment reconciliation

Every registry mutation atomically regenerates files in the private state
directory; startup regenerates them after an interrupted deployment:

- `authorized_keys`: one `restrict,port-forwarding,command=...` entry per node,
  with `permitlisten` limited to that node's assigned loopback IPv4/IPv6 port
  and `permitopen` confined to that same endpoint (preventing use of local
  forwarding as a general host-network pivot);
- `known_hosts`: host keys keyed by the stable node ID;
- `ssh_config`: aliases `familiar-fleet-<host>` with strict host-key checking,
  the pinned known-hosts file, and optional controller identity path;
- `herdr-machines.json`: a declarative machine manifest binding each alias to
  the named remote session `familiar-fleet`.

Do **not** make these generated files writable by the HTTP service's request
inputs via arbitrary paths. Configure the tunnel sshd account with this exact
`authorized_keys` as its `AuthorizedKeysFile`, and include `ssh_config` from the
controller account's SSH configuration. Reload sshd only if that deployment
requires it; OpenSSH normally reads authorized keys on each connection.

Herdr 0.9.1 machine storage has operational/version-specific CLI behavior, so
the gateway intentionally does not execute `herdr machine add` in a request
handler. A deployment reconciler should watch the atomically replaced
`herdr-machines.json` and invoke the pinned Herdr binary with an argv array (not
a shell string), creating/updating profiles by `name`, `ssh_alias`, and
`session`. It must also remove only profiles previously owned by this manifest.
This is the explicit integration seam; existing profiles remain present while a
node is merely offline.

The enrollment route inherits the gateway's existing authentication boundary.
There is deliberately no second bearer token or OAuth implementation: by
default only loopback can reach it, and a remote deployment must expose `/fleet`
through the same identity-authenticating reverse proxy as the rest of the
Gateway. The proxy must discard client-supplied identity headers. Enabling the
Gateway's explicit non-loopback escape hatch without such a proxy exposes all
Gateway routes and remains unsafe.

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
