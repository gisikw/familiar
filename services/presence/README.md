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

## Worker and reload contract

The production worker runs `./familiar.sh pi`. It keeps pi alive after crashes
and always launches it with `--continue`. `/refamiliarize` writes
`state/run/reload-request` and gracefully exits pi; the worker atomically moves
that marker to `state/run/reload-complete`, re-enters the current Familiar
script/config/dev shell, and restarts pi with `--continue`. The extension
consumes the completion marker and submits `Reload complete` to the resumed
session. No viewer is involved in restart semantics.

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

Pane 1 runs the equivalent of:

```sh
TMUX= tmux -S state/presence/tmux.sock attach-session -t presence
```

Clearing `TMUX` permits this nested same-server attach. The outer Viewer has
session-local `prefix None`, `status off`, `mouse off`, and
`pane-border-status off`; users cannot operate its chrome and mouse sequences
pass to the inner client. Presence retains its `C-b` prefix and ordinary
behavior. `allow-passthrough on` is enabled in the owned config and explicitly
on the Viewer window so kitty APCs can cross both tmux layers.

## Tests

```sh
bash services/presence/test.sh
nix flake check --no-build
```

The focused test uses only temporary private sockets and a fake worker. It
covers config isolation, worker continuity/recovery, concurrency, path and stop
isolation, idempotent Viewer creation, session-scoped options, the 28-column
resize lock, nested attach command shape, and the Gateway entrypoint contract.
