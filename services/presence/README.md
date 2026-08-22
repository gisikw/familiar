# Familiar Presence Runtime (tmux adapter)

This service owns the resident interactive `./familiar.sh pi` process and the
terminal viewer around it. Both sessions live on one private tmux server;
browser terminals and local/SSH attaches are disposable viewers. This adapter
is not a generic agent launcher or public protocol.

```text
browser /pty or SSH
  -> presence.sh viewer
  -> viewer session: [ 28-column sidebar | nested tmux client ]
                                      -> presence session -> familiar.sh pi
```

## Commands

```sh
services/presence/presence.sh ensure          # make the worker live
services/presence/presence.sh ensure-viewer   # headless/idempotent setup
services/presence/presence.sh viewer          # setup and attach to viewer
services/presence/presence.sh attach          # alias of viewer
services/presence/presence.sh attach-presence # direct debug attach to pi
services/presence/presence.sh status [--quiet]
services/presence/presence.sh stop
```

The defaults are `state/presence/`, `state/presence/tmux.sock`, session
`presence`, and viewer session `viewer`. `FAMILIAR_PRESENCE_STATE_DIR`,
`FAMILIAR_PRESENCE_SOCKET`, `FAMILIAR_PRESENCE_SESSION`, and
`FAMILIAR_VIEWER_SESSION` override them. State and socket must be absolute, the
socket must remain beneath state, and symlink/non-socket surprises are rejected.

The server is selected exclusively with `tmux -S` and starts with the owned
`tmux.conf`; system and user configs are not read. `ensure` is serialized with
a bounded file lock and recovers only a missing/dead owned worker.

## Worker continuity contract

The production worker runs `./familiar.sh pi` in a simple respawn loop. If that
command exits unexpectedly, the worker waits briefly and launches it again.
Familiar always starts pi with `--continue`, so crash recovery resumes the most
recent session. No viewer is involved in worker restart semantics.

`./familiar.sh kill` explicitly stops this private tmux server. Viewer loss does
not. Upload notifications use the server-to-extension relay and report
`notified:false` if no pi subscriber is connected; uploaded bytes remain saved.

`FAMILIAR_PRESENCE_COMMAND` is a test/development override.

## Viewer layer

Viewer has exactly two panes. Pane 0 is resized to 28 columns at creation and by
`client-resized`, `window-resized`, and `after-split-window` hooks. It runs
`sidebar.sh` under a resident supervisor, with a `pane-died` respawn hook. The
script rasterizes `assets/familiar-mark.svg` with `rsvg-convert`, colors it with
the Familiar accent, and transmits the PNG with chunked kitty graphics APC
sequences. It redraws on `WINCH` and periodically for late clients. Missing
assets, `rsvg-convert`, or `base64` degrade to a styled `familiar` label.
Below the caption, a compact registry tree groups the ten most relevant agent
jobs by workspace, prioritizes active work, and refreshes from the local agent
service every ten seconds; an unavailable or empty registry leaves the area clean.

Pane 1 runs the equivalent of:

```sh
TMUX= tmux -S state/presence/tmux.sock attach-session -t presence
```

Clearing `TMUX` permits this nested same-server attach. The outer Viewer has session-local `prefix None`, `status off`, `mouse off`,
and `pane-border-status off`; users cannot operate its chrome and mouse
sequences pass to the inner client. Pane 1 is selected at creation and on each
client attach, while pane 0 has input disabled. Presence retains its `C-b`
prefix and ordinary behavior.

The sidebar wraps each kitty APC in tmux's DCS passthrough envelope (including
ESC doubling); raw kitty APCs are parsed and discarded by tmux rather than
forwarded. `allow-passthrough all` is enabled globally and explicitly on the
Viewer window so wrapped repaints can cross tmux regardless of visibility.
Extended keys and `extkeys` terminal features are enabled for common direct and
nested client TERM families.

## Tests

```sh
bash services/presence/test.sh
nix flake check --no-build
```

The focused test uses only temporary private sockets and a fake worker. It
covers config isolation, worker continuity/recovery, concurrency, path and stop
isolation, idempotent Viewer creation, passthrough and extended-key options,
main-pane focus, disabled sidebar input, the 28-column resize lock, nested
attach command shape, and the Gateway entrypoint contract.
