# Familiar Presence (tmux TTY adapter)

Presence owns the private tmux TTY; systemd owns the Pi process lifecycle. The
production `familiar-pi@<instance>.service` invokes `start`, records the pane PID
as its `MainPID`, and applies `Restart=`. Nothing else creates or respawns Pi.

```text
systemd -> presence.sh start -> private tmux pane -> familiar.sh pi
browser/SSH -> familiar-viewer -> tmux attach client --------^
```

Commands:

```sh
presence.sh start           # unit primitive; create one pane and PID file
presence.sh viewer          # attach-only native viewer; fails if Pi is down
presence.sh attach-presence # direct debug attach; fails if Pi is down
presence.sh status [--quiet]
presence.sh stop
```

`ensure` is intentionally rejected. `viewer`, `attach`, and
`attach-presence` never start a session. The pane runs `familiar.sh pi` exactly
once; after it exits tmux removes the pane, systemd observes the pane PID and
restarts the unit. `--continue` remains in `familiar.sh pi`, so a restart selects
the most recent session from that instance's `PI_CODING_AGENT_DIR`.

Defaults are `state/presence/`, `state/presence/tmux.sock`, session `presence`,
and PID file `state/presence/pi.pid`. The corresponding `FAMILIAR_PRESENCE_*`
variables override them. State is private, the socket and PID file must remain
beneath it, and symlink surprises are rejected. The tmux server uses only the
owned config; viewer clients are disposable and do not own lifecycle.

`FAMILIAR_PRESENCE_COMMAND` is a test-only pane command override.

Run focused tests with `bash services/presence/test.sh`.
