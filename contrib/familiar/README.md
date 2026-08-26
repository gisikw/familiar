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

Terminal activation is emitted for **any** job — running or settled — whenever
the exact local tmux session is still live. The renderer verifies the precise
target with `tmux -S <socket> has-session -t =<session>` (exact-name match),
not mere socket existence, and reduces `worker-…:0.0` to the exact session name
attached unchanged. Golem retains a settled tmux session for its linger window
(default 1h, `--linger` / `GOLEM_LINGER_SECONDS`), so a done/failed/cancelled/
timeout job stays visible and **clickable** for its retained lifetime; once the
exact session is reaped the activation drops and the viewer removes the row
under its terminal-row policy. In the sidebar, settled-but-retained rows render
faded (DIM + their state color) to read as inactive while remaining clickable,
and failure/cancel colors are preserved. A running job with no live terminal
stays visible but non-actionable. Diagnosable tmux faults (permission denied,
tmux missing) are logged at most once per socket per minute so a fault stays
observable without flooding the log under frequent polling.

Familiar API-1 cannot represent SSH activation, so a remote-only job with no
live local terminal remains non-actionable and its label includes an explicit
`ssh user@host:port; use golem attach` hint (the status remains the exact state
so Familiar's state coloring still applies).

The packaged `golem-familiar-render` is wrapped so `tmux` is on its PATH for the
liveness check; the render adapter must be able to reach the Golem tmux server
socket (see the fort-nix ownership fix).

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
