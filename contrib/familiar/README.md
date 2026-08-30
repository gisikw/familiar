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
the exact local tmux session is still live. Each projection takes one
`tmux -S <socket> list-sessions -F '#{session_name}'` snapshot per unique
socket (never a process per row) and decides activation by exact set membership
of the normalized session name (`worker-…:0.0` → `worker-…`, attached
unchanged). External tmux probes run *after* the job snapshot is copied out and
the internal lock released, so rendering never blocks state updates. Golem retains a settled tmux session for its linger window
(default 1h, `--linger` / `GOLEM_LINGER_SECONDS`), so a done/failed/cancelled/
timeout job stays visible and **clickable** for its retained lifetime; once the
exact session is reaped the activation drops, but its dim non-clickable row
remains inspectable for the renderer's 24-hour window. Whenever any settled job
exists, the sidebar also reserves a clickable ASCII-bordered **Retire Golems**
action. It asks golemd to DELETE only the snapshotted terminal job ids; running
and blocked jobs are never submitted. Settled-but-retained rows render faded
(DIM + their state color) to read as inactive while remaining clickable,
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

## Settlement relay (jobs → worklist)

The Pi extension also runs a resilient background **settlement relay**. When a
job dispatched through `agents_dispatch` reaches a terminal state
(`done`/`failed`/`cancelled`/`timeout`), the relay fetches its authoritative
detail and enqueues a concise worklist item. This respects the worklist's
ATTENTION policy — it NEVER calls `pi.sendMessage`. If no worklist channel is
available the built envelope is retained and retried; delivery is never forced
past attention.

**Two delivery channels (fast path + durable fallback).** First choice is the
neutral in-process `worklist.durable-sink@1` capability (`WORKLIST_SINK`),
resolved lazily so worklist/agents loader order is irrelevant. But pi's
extension loader can hand this *external contrib plugin* and the *built-in
worklist extension* SEPARATE module instances, so the process-local capability
registry singleton does not always cross that boundary and `resolveSink()` can
stay `undefined` even though worklist is loaded and its dirs exist. When the
sink is unresolvable (or throws), the relay falls back to worklist's OFFICIAL
out-of-process durable drop-box (`PROTOCOL.md` §Enqueue paths (b)): it
atomically writes the same stable-id envelope to
`$FAMILIAR_WORKLIST_DIR/incoming/<safe-id>.json`, which worklist drains on its
timer and dedupes on the stable id. A successful atomic rename IS durable
acceptance — only then does the relay write its tombstone and clear
pending/owned. The drop-box filename is derived from our sanitized job id
(independent of any untrusted id); the envelope's stable `id` field remains
authoritative for worklist's dedup. An explicit `{accepted:false}` from a *real*
sink is honoured (retain) rather than shadow-written behind the sink's back.

The item's stable id is `golem-settle-<sanitized job id>` so replay is
idempotent. Priority is P1 for a non-success settlement and P2 for `done`. The
body carries job id, state, verdict, workspace/harness/model, artifact list, and
usage when present (read from golemd's nested `settlement.usage`, with a
top-level `usage` fallback).

**Ownership (anti-flood).** Only jobs THIS extension dispatched are relayed. A
dispatch records a durable ownership marker; a fresh instance owns nothing, so
following the durable SSE feed from `since=0` on first start enqueues no
historical host jobs. Jobs dispatched by unrelated clients are deliberately not
claimed (they belong to whichever client dispatched them).

**Durability & exactly-once.** State lives under
`FAMILIAR_AGENTS_STATE_DIR` (or `$PI_CODING_AGENT_DIR/golem-settlement`), never
in source: a cursor, per-job `owned/`, `pending/` (retriable envelope), and
`done/` (tombstone) — all atomic temp+rename. Exactly-once is best-effort across
replay/restart via three layers: the sink dedupes on the stable id, a local
tombstone skips already-relayed jobs, and a durable pending envelope survives
restart and sink outages. The drop-box fallback shares the same guarantee: the
atomic incoming write happens BEFORE the tombstone, so a crash in between simply
replays the same stable id — harmless whether the file is still queued or already
drained, because worklist dedups against its live+archive history. The cursor is only an optimization; on start, on every
periodic maintenance tick (20s), and after repeated SSE failures the relay
reconciles every owned-unsettled job so an event missed below the cursor (or a
very fast job that settles around dispatch registration) still settles. The
periodic tick is a bounded backstop even while the SSE stays HEALTHY-but-silent
— e.g. if the endpoint/DB is replaced and its event sequence is below the stored
cursor, so future settlements would otherwise never arrive as events. All
maintenance, SSE-driven reconciliation, and flushing run on a single serial
chain, so the same pending envelope is never concurrently submitted to the sink.

**Not covered (by design).** This client exposes no `await`/claim tool, so there
is no await-race to dedup against — the relay does not call `sink.withdraw()` or
simulate a partial claim protocol. If neither the in-process sink nor a valid
worklist drop-box dir (`FAMILIAR_WORKLIST_DIR`) is available, the settlement is
retained as pending and retried. If the durable state directory is wiped, the
ownership marker for an in-flight job is lost and that settlement will not be
relayed (ownership is the anti-flood contract). The relay is disabled if no
state directory can be derived; the tools remain fully functional.

## Tests

```sh
(cd contrib/familiar/render && go test ./...)
bun test contrib/familiar/pi/agents   # includes the settlement relay suite
go test ./...                    # from services/server
```

All plugin tests use local stubs; no golemd or network is required.
