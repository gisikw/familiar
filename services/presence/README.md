# Familiar Presence Runtime (temporary tmux adapter)

This service owns the one full interactive `./familiar.sh pi` process. It hides
that process behind a private tmux server so Herdr and browser terminals are
only disposable viewers. This is an adapter for the current pi TUI, **not** a
generic agent launcher or a public protocol.

## Contract

```sh
services/presence/presence.sh ensure   # idempotently make the worker live
services/presence/presence.sh attach   # ensure, then replace self with a viewer
services/presence/presence.sh status [--quiet]
services/presence/presence.sh stop     # explicit destruction of owned server
```

The defaults are `state/presence/`, `state/presence/tmux.sock`, session
`presence`. `FAMILIAR_PRESENCE_STATE_DIR`, `FAMILIAR_PRESENCE_SOCKET`, and
`FAMILIAR_PRESENCE_SESSION` override them. State and socket must be absolute,
the socket must remain beneath state, and symlink/non-socket surprises are
rejected. State is mode 0700; lock and copied config are 0600.

The server is always selected with `tmux -S` and created with the owned,
explicit `tmux.conf` via `-f`; default/user servers and configs are not used.
There is one pane, no status or pane-border chrome, and normal `C-b` command
access remains. `remain-on-exit` leaves crashes recoverable. `ensure` uses a
bounded file lock and respawns only a dead/missing owned pane. Attach-client
exit never reaches the worker.

`FAMILIAR_PRESENCE_COMMAND` exists only as a test/development override. The
production worker is exactly `./familiar.sh pi`, whose existing restart loop
continues to own pi crash recovery and transcript continuation.

## Reload and shutdown

`/refamiliarize` leaves the reload marker, exits pi, and stops Herdr as before.
The tmux dead pane does not auto-respawn. The outer launcher moves the marker to
reload-complete, starts the updated Herdr environment, and the new viewer's
`ensure` respawns the pane once with new code. `./familiar.sh kill` explicitly
stops Herdr and this private tmux server. Ordinary Herdr/viewer loss does not.

Uploads use the existing server-to-extension relay compatibility ingress rather
than trying to discover pi through Herdr. It reports `notified:false` when no pi
relay subscriber is connected; the uploaded bytes remain saved.

## Tests

```sh
bash services/presence/test.sh
nix flake check ./services/presence
nix build ./services/presence
```

The focused test uses isolated sockets and a fake worker; it checks PID
continuity, reattachment, concurrency, dead/session recovery, hostile user
config isolation, chrome/prefix options, path safety, and stop isolation.
