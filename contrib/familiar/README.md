# Golem client plugin

This API-1 contribution lives in Familiar because it is a Familiar UI/Presence
client, not part of golemd. Familiar's current plugin loader looks for
`contrib/familiar/plugin.toml`, so enroll the **Familiar checkout root**:

```toml
[plugins.golem]
path = "/absolute/path/to/familiar"

[plugins.golem.env]
GOLEM_ENDPOINT = "unix:///run/user/1000/golem/golemd.sock"
# GOLEM_TOKEN = "..." # required for a token-protected TCP endpoint
```

An immutable Familiar Git source may be used instead of `path` as described in
`docs/PLUGIN-HOST.md`. The environment is string-only and is injected into both
plugin services and Presence. Supported settings are:

- `GOLEM_ENDPOINT`: `unix:///absolute/socket` or an HTTP(S) URL (default
  `http://127.0.0.1:7337`).
- `GOLEM_TOKEN`: optional bearer token. It never appears in job data.
- `GOLEM_RENDER_LISTEN`: render listener (default `127.0.0.1:7340`; the manifest
  render URL assumes this default).
- `GOLEM_REPO_PATH`: enables the optional local golemd fallback, and must point
  to a Golem flake checkout. If absent, that child is inert; a system-managed
  golemd is the intended deployment.
- `GOLEM_CONFIG` (required when enabling the fallback), plus optional
  `GOLEM_STATE` and `GOLEM_LISTEN`: fallback golemd flags.

The render process takes an initial job snapshot, then follows the durable SSE
feed with `since=<last sequence>`. Each event refreshes the affected job so
terminal and settlement fields are authoritative. Reconnect preserves the
cursor; after three consecutive stream failures it refreshes the complete job
list on every retry, so polling is the degraded fallback. Settled rows remain
for 24 hours (up to 20 total rows).

Only Familiar's existing terminal activation is emitted. A live local
`terminal.socket` must exist; its target is reduced to the exact tmux session
name and attached unchanged. Familiar API-1 cannot represent SSH activation,
so a remote-only job remains non-actionable and its label includes an explicit
`ssh user@host:port; use golem attach` hint (the status remains the exact state
so Familiar's state coloring still applies). Settled jobs never activate and use
the settlement verdict as their clipped row label.

The Presence extension speaks HTTP directly (including Unix-domain HTTP), which
avoids a CLI subprocess, shell/argv configuration, and a runtime dependency on
Golem source. Dispatch always checks live capabilities before POSTing and sends
only harness/model/workspace/prompt/idempotency identity—never providers or
credentials. Tools cover capabilities, dispatch, list/status, answer, steer,
cancel, artifact listing, and bounded base64 artifact fetch. Blocked status includes golemd's
question object.

## Tests

```sh
(cd contrib/familiar/render && go test ./...)
bun test contrib/familiar/pi/agents
go test ./...                    # from services/server
```

All plugin tests use local stubs; no golemd or network is required.
