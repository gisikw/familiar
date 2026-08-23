# Familiar Presence Runtime (tmux adapter)

This service owns only the resident interactive `./familiar.sh pi` process and
its private inner tmux session. Presentation belongs to the native
`familiar-viewer`; viewer processes and their tmux attach clients are disposable
and never own worker lifecycle.

```text
browser gateway or SSH shell
  -> native familiar-viewer
  -> tmux attach client -> presence session -> familiar.sh pi
```

## Commands

```sh
services/presence/presence.sh ensure          # make the worker live
services/presence/presence.sh viewer          # ensure, then exec native viewer
services/presence/presence.sh attach          # compatibility alias of viewer
services/presence/presence.sh attach-presence # direct tmux debug attach
services/presence/presence.sh status [--quiet]
services/presence/presence.sh stop
```

The SSH ritual is intentionally simple: log in normally, then run
`services/presence/presence.sh viewer`. The command first ensures the inner
session, then execs `FAMILIAR_VIEWER_BIN` when set or `familiar-viewer` from
`PATH`; it passes no arguments. Presence exports its normalized runtime socket
environment and derives `FAMILIAR_AGENTS_SOCKET` from
`FAMILIAR_AGENTS_SUPERVISOR_STATE` when needed before exec.

The defaults are `state/presence/`, `state/presence/tmux.sock`, and session
`presence`. `FAMILIAR_PRESENCE_STATE_DIR`, `FAMILIAR_PRESENCE_SOCKET`, and
`FAMILIAR_PRESENCE_SESSION` override them. State and socket must be absolute,
the socket must remain beneath state, and symlink/non-socket surprises are
rejected.

The server is selected exclusively with `tmux -S` and starts with the owned
`tmux.conf`; system and user configs are not read. `ensure` is serialized with
a bounded file lock and recreates a missing owned session. Dead panes do not
linger: when the sole worker pane exits, tmux removes the session, and the next
ensure creates it afresh. It does not create presentation processes.

## Worker continuity contract

The production worker runs `./familiar.sh pi` in a simple respawn loop. If that
command exits unexpectedly, the worker waits briefly and launches it again.
Familiar always starts pi with `--continue`, so crash recovery resumes the most
recent session. Closing or killing a viewer affects only its attach client.

`./familiar.sh kill` explicitly stops the private tmux server. Upload
notifications use the server-to-extension relay and report `notified:false` if
no pi subscriber is connected; uploaded bytes remain saved.

`FAMILIAR_PRESENCE_COMMAND` is a test/development override.

## Inner tmux policy

`tmux.conf` configures the inner Presence session. It retains ordinary `C-b`
behavior, mouse defaults, `allow-passthrough all`, extended keys, and explicit
terminal features, while leaving `remain-on-exit` disabled so dead panes vanish. These are needed by pi and by Kitty graphics crossing the
native viewer's embedded PTY. Viewer chrome, native sidebar layout, job
navigation, Kitty graphics, and target switching are implemented by
`services/viewer`, not this adapter.

## Tests

```sh
bash services/presence/test.sh
```

The focused test uses temporary private sockets and a fake worker. It covers
config isolation, one-session ownership, native-viewer exec resolution and
environment, attach/detach continuity, concurrent viewers and ensures,
missing-session and worker-death recovery, socket safety, scoped stop behavior, and the
Gateway browser-entrypoint contract.
