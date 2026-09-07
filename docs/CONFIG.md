# Local configuration

Familiar reads `familiar.toml` before applying defaults and before its first
`nix develop` recursion. Use `./familiar.sh --config /path/to/private/familiar.toml`
as shorthand for `FAMILIAR_CONFIG_PATH`. Relative `[familiar]` paths are anchored
at the TOML file's directory. Copy the committed schema and protect it before
adding credentials:

```sh
cp familiar.toml.example familiar.toml
chmod 600 familiar.toml
```

`familiar.toml` is gitignored and the loader refuses any mode other than 0600.
The legacy `.env` file is not sourced or otherwise read.

## Environment mapping

TOML leaf paths are joined with `_`, uppercased, and characters other than
ASCII letters, digits, and `_` are normalized to `_`. One `FAMILIAR_` prefix is
added unless the flattened name already starts with it. Examples:

| TOML | Export |
|---|---|
| `accent = "x"` under `[theme]` | `FAMILIAR_THEME_ACCENT=x` |
| `api-key = "x"` under `[brave]` | `FAMILIAR_BRAVE_API_KEY=x` |
| `debug_level = "off"` under `[familiar]` | `FAMILIAR_DEBUG_LEVEL=off` |
| `use_stuff = true` under `[familiar]` | `FAMILIAR_USE_STUFF=true` |

Every key must live under a canonical table (`[pi]`, `[anthropic]`, `[familiar]`,
etc.). Bare top-level keys are rejected: flat spellings such as `pi_offline`,
`anthropic_base_url`, or `tts_url` are no longer accepted because they collide
with their grouped canonical forms after flattening. Use the tables shown in
`familiar.toml.example`.

Normalization is deterministic but does not split camelCase. Prefer snake_case.
If two TOML paths normalize to the same name, loading fails rather than choosing
one.

Values have these stable environment representations:

- strings: exact TOML string contents, including spaces and newlines;
- booleans: `true` or `false`;
- integers and floats: canonical JSON number text;
- arrays: compact JSON (for example `["one",2,false]`).

Tables are recursively flattened. Other leaf types are rejected. Nix's built-in
TOML parser is used because `nix` is the one runtime installation already
requires before a dev shell exists. Values are transferred with byte-length
framing and Bash assignment, never shell evaluation. Parser diagnostics are
suppressed so malformed files cannot echo credentials.

## Precedence and process lifetime

Precedence, highest first:

1. `FAMILIAR_*` variables present in the ambient process environment;
2. values from `familiar.toml`;
3. defaults in `familiar.sh` and `flake.nix`.

The loader records which variables were truly ambient, exports file values, and
reloads on every recursive entry. Consequently file values survive a dev shell
that sets the same name, while an explicit ambient override remains untouched.
The provenance marker and all loaded values survive `nix develop` recursion.
The loader also records its own exports separately. On each successful reload
it clears that prior set (including upstream aliases)
before applying the new snapshot, so removing a key really removes its stale
value while the original ambient set remains untouched. This includes a
same-session JSON-to-setup-token cutover.

## Canonical groups and migration

Use tables whose names match the established environment prefix: `[pi]`,
`[ui]`, `[anthropic]`, `[openai]`, `[tiamat]`, `[server]`, `[plugins]`, `[herdr]`,
`[subagent]`, `[model]`, `[llama]`, `[stt]`, `[tts]`, `[searxng]`, `[brave]`,
`[fetch]`, `[zip]`, and `[theme]`.
Cross-cutting
paths and runtime policy live under `[familiar]`; the loader deliberately does
not double that prefix. When `[familiar] use_stuff = true`, the identity
extension adds one compact system-prompt nudge that the `stuff` CLI exists and
can explain itself with `stuff --help`; it does not load a separate skill or
turn Stuff into an orchestrator. In the main Pi editor, `Ctrl+S` (or
`/stuff-capture`) opens a quick capture flow for an Item title and optional
linked Note. These are the mechanical moves from the retired flat
spellings to the canonical tables (the effective export name is unchanged):

| Retired flat key | Canonical key | Effective export |
|---|---|---|
| `pi_offline` | `[pi] offline` | `FAMILIAR_PI_OFFLINE` |
| `identity_path` | `[familiar] identity_path` | `FAMILIAR_IDENTITY_PATH` |
| `anthropic_base_url` | `[anthropic] base_url` | `FAMILIAR_ANTHROPIC_BASE_URL` |
| `stt_url` | `[stt] url` | `FAMILIAR_STT_URL` |
| `tts_voice` | `[tts] voice` | `FAMILIAR_TTS_VOICE` |
| `brave_api_key` | `[brave] api_key` | `FAMILIAR_BRAVE_API_KEY` |

The `[herdr]` and `[subagent]` tables are retained for the current
worker/session integration. See `familiar.toml.example` for their complete
key list. `[plugins.golem]` is the sole reduced boot-time source enrollment;
see [PLUGIN-HOST.md](PLUGIN-HOST.md). Anthropic also accepts `claude_credentials_json` or
`claude_oauth_token`; never put real credentials in the committed example.

Flat top-level keys are no longer supported: the loader rejects any key that is
not under a table, so the old and new spellings cannot both exist. `chmod 600
familiar.toml`, then run `bash test/familiar-config.test.sh` for the loader
check or cold-start Familiar. Neither path displays values. Migration is a
one-time move of each key under its canonical table.

A few upstream programs require established non-Familiar names. Familiar maps
`FAMILIAR_PI_TELEMETRY`, `FAMILIAR_PI_OFFLINE`, and
`FAMILIAR_PI_SKIP_VERSION_CHECK` and `FAMILIAR_PI_CODING_AGENT_DIR` to
their `PI_*` counterparts, and maps `FAMILIAR_ANTHROPIC_BASE_URL`,
`FAMILIAR_ANTHROPIC_API_KEY`, and `FAMILIAR_ANTHROPIC_AUTH_TOKEN` to
`ANTHROPIC_*`. It maps `[openai]` URL/key to `OPENAI_BASE_URL` and
`OPENAI_API_KEY`, and covers `LLAMA_BASE_URL`. An upstream name that was explicitly ambient is preserved.
Local configuration should always use the
generic Familiar names shown in `familiar.toml.example`.

## familiar-ui tracked deployment contract

The browser bridge is an extension inside the **existing resident interactive Pi
process**. Familiar does not launch a second Pi or an RPC embedding. Because
`gisikw/familiar-ui` is a separately released repository whose build outputs and
`node_modules` are intentionally untracked, it is not copied into this repository
and is not represented by a machine-private flake input.

Fort/Azula supplies a sibling checkout and these exact values (ambient variables
or the equivalent `[ui]` keys):

- `FAMILIAR_UI_SOURCE` / `[ui] source`: checkout path (relative config paths are
  anchored at the private instance);
- `FAMILIAR_UI_REV` / `[ui] rev`: required full 40-character commit SHA;
- production `FAMILIAR_UI_ORIGIN` and `FAMILIAR_UI_PORT` (`[ui] origin`,
  `port`): the exact public HTTPS browser origin and a fixed unprivileged
  loopback bridge port; development may retain familiar-ui's loopback defaults;
- optional `FAMILIAR_UI_DESCRIPTOR` / `[ui] descriptor`, defaulting to stable
  private state at `state/familiar-ui/bridge.json`.

Familiar verifies the checkout SHA and clean tracked tree, then evaluates
`path:$FAMILIAR_UI_SOURCE#familiar-ui` with `nix build --no-link`. The UI's
committed `flake.lock` and `importNpmLock` build the extension, browser, broker,
workspace packages, and npm dependencies into one immutable Nix output. Ignored
checkout `dist/` and `node_modules/` trees cannot enter that build. Familiar
validates the packaged runtime closure before adding
`$out/share/familiar-ui/packages/extension/dist/index.js` to Pi's explicit
extension list. A missing, dirty, unpinned, unbuildable, or malformed configured
checkout fails startup rather than loading an old ad-hoc artifact. If `[ui]
source` is omitted, no external UI extension is added.
The extension itself retains exact Origin checks, bound-Host validation, a
per-session bearer token, and loopback-only binding; the integration provides no
bypass for any of them.

The Fort patch uses the **same Nix output** for the browser deployment. Resolve
it without activating Presence using:

```sh
scripts/familiar-ui-extension.sh package /absolute/path/to/familiar-ui FULL_SHA
```

Serve `$out/share/familiar-ui/web` at the exact HTTPS origin. Run
`$out/bin/familiar-ui-broker` as a separate, unprivileged descriptor service
with `FAMILIAR_UI_DESCRIPTOR`, `FAMILIAR_UI_ORIGIN`, and `FAMILIAR_UI_PORT`
identical to Presence, plus `FAMILIAR_UI_PUBLIC_ORIGIN` equal to the served
HTTPS origin and a private `FAMILIAR_UI_BROKER_SOCKET`. The HTTPS reverse proxy
serves `GET /__familiar/bridge.json` from that Unix socket and proxies `/v1/*`
to `127.0.0.1:$FAMILIAR_UI_PORT`, preserving the exact public `Origin`, rewriting
`Host` to the exact loopback authority expected by the bridge, and forwarding
the browser's `Authorization` header. Do not expose the loopback listener,
descriptor file, token, or broker socket. The broker redacts loopback URL and
process metadata; it does not relax bridge authentication.

### Activation gate

A deploy/review may prepare the checkout, Nix build, config, and feature branch,
but **must not restart `familiar-instance-presence` directly or
indirectly**. It must not merge to `main` if tracked deployment would activate or
restart the live Presence before review. Kevin activates this change manually
with `/reload`, then explicitly confirms activation. Until that confirmation,
Fort and automation must perform no service restart, Presence ensure/recreate,
or equivalent tracked-deployment action. `/reload` preserves durable wake
records: shutdown clears only in-memory timers and the replacement extension
restores them on `session_start`.

## Changes and failures

After editing, keep mode 0600, run `./familiar.sh config-check`, then stop and
rerun `./familiar.sh`. A cold restart regenerates
the unified theme and restarts services with the new exports. Malformed TOML,
unsupported types, normalized-key collisions, and insecure permissions abort
ordinary startup with a secret-suppressed error. They do not brick the bounded
recovery/operational verbs `kill` and `worklist-add` (`inbox-enqueue` alias):
those continue using ambient values and defaults after a loud warning. Identity
and voices are ordinary files in the private instance; public-transit
ciphertext remains the responsibility of its owning integration. `config-check` remains runnable and returns nonzero until the optional file is
fixed or moved aside. Other launch verbs fail closed and do not silently ignore
the file.

To retire a legacy `.env`, do **not** source it as a migration shortcut. Accept
only plain assignments whose quoting can be decoded without expansion, remove a
single leading `FAMILIAR_` from each key, write the values as TOML strings, then
compare the old and new effective environments without displaying values. Stop
and migrate manually if command substitutions, parameter expansion, shell
commands, or other executable syntax appears.
