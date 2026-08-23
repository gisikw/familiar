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
sequences. Missing assets, `rsvg-convert`, or `base64` degrade to a styled
`familiar` label. Below the caption, a compact registry tree groups the ten
most relevant agent jobs by workspace, prioritizes active work, and checks the
local agent service every ten seconds; an unavailable or empty registry leaves
the area clean. A canonical frame diff makes an unchanged check emit no terminal
bytes. Changed tree rows use cursor addressing plus erase-to-end-of-line, and
each paint is enclosed in synchronized-output brackets.

Pane 1 runs the equivalent of:

```sh
TMUX= tmux -S state/presence/tmux.sock attach-session -t presence
```

Clearing `TMUX` permits this nested same-server attach. The outer Viewer has session-local `prefix None`, `status off`, `mouse off`,
and `pane-border-status off`; users cannot operate its chrome and mouse
sequences pass to the inner client. Pane 1 is selected at creation and on each
client attach, while pane 0 has input disabled. Presence retains its `C-b`
prefix and ordinary behavior.

The sidebar uses the kitty protocol's Unicode-placeholder mode, which restty
and Ghostty render. A passthrough-wrapped APC transmits image id 1 as a 16-by-8
**virtual** placement (`U=1`); it never creates a cursor-positioned placement.
The script then writes U+10EEEE cells with explicit canonical row/column
diacritics and truecolor foreground `0x000001` through the normal terminal grid.
tmux therefore positions, stores, clears, and replays the visible mark with the
sidebar pane instead of relying on the outer terminal cursor.

Because tmux replays grid cells but not passthrough APC data, the sidebar polls
`tmux list-clients` every two seconds. A sorted fingerprint including client
identity, tty, creation time, and session detects count changes and same-count
reattaches. Each new nonempty attach epoch retransmits under the same image id
without first deleting it; placeholder cells remain untouched, avoiding a
blink. `WINCH` also performs this check.

Raw kitty APCs are parsed and discarded by tmux, so image-data commands remain
inside tmux DCS passthrough envelopes (with ESC doubling). `allow-passthrough
all` is enabled globally and explicitly on the Viewer window. Cursor movement
must not be put in passthrough: tmux continually reasserts the active main
pane's outer cursor, which previously caused duplicate/footer artifacts.

Unicode placeholders are also the intended mechanism for future pi-frame
images inside nested tmux: every tmux layer can treat their anchors as ordinary
grid text while only the data transmission bypasses it. This depends on each
layer preserving U+10EEEE, combining marks, and truecolor. The current
outer-Viewer/inner-Presence path proves those properties for restty and tmux,
but future pi-frame work must use distinct stable image ids and verify its
additional nesting depth.

Extended keys and `extkeys` terminal features are enabled for common direct and
nested client TERM families, including explicit `ghostty*` and `xterm-ghostty`
entries.

A direct Ghostty attach is supported. An additional user-owned tmux between the
Familiar Viewer and Ghostty is not transparent by default: Familiar's tmux
consumes its own DCS envelope and sends a raw kitty APC onward, which that outer
tmux will discard. There is no reliable in-band success probe from the sidebar,
so it cannot automatically substitute text in this case. Configure the user's
tmux with `set -g allow-passthrough all` (and use a tmux version that forwards
kitty graphics), or attach outside that extra tmux. The text fallback only
covers failures detectable in the Familiar sidebar process.

## Tests

```sh
bash services/presence/test.sh
nix flake check --no-build
```

The focused test uses only temporary private sockets and a fake worker. It
covers config isolation, worker continuity/recovery, concurrency, path and stop
isolation, idempotent Viewer creation, passthrough and extended-key options,
the virtual-placement/normal-grid anchor contract, main-pane focus, disabled
sidebar input, the 28-column resize lock, nested attach command shape, and the
Gateway entrypoint contract.
