# Familiar Presence Runtime (temporary tmux adapter)

This service owns the resident interactive `./familiar.sh pi` process behind a
private tmux server. Browser terminals and local/SSH attaches are disposable
viewers. This adapter is not a generic agent launcher or public protocol.

## Contract

```sh
services/presence/presence.sh ensure
services/presence/presence.sh attach
services/presence/presence.sh status [--quiet]
services/presence/presence.sh stop
```

The defaults are `state/presence/`, `state/presence/tmux.sock`, and session
`presence`. State is private and path/symlink checks prevent attaching to an
unowned tmux server. `ensure` uses a bounded lock and repairs a dead pane.

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
