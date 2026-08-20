# Kitty graphics on the web attach path — root cause & fix

## Symptom
The herdr sidebar brand mark (scripts/herdr-sidebar.sh, chunked base64 `_G` APC,
f=100 PNG, a=T with c/r cell scaling) renders when attaching from ghostty but
NOT via the web path (browser restty → WS → node-pty → `herdr session attach`).
restty's own demo shows kitty graphics in the browser, so restty is capable.

## Root cause — HYPOTHESIS 1 (herdr-side capability gating)
herdr's attach **client** decides whether to forward a pane's kitty graphics APC
to the connected terminal by sniffing the OUTER terminal's ENVIRONMENT
fingerprint — NOT by an APC `a=q` query round-trip.

Evidence (strings from the herdr 0.8.1 binary):
- `event src/client/mod.rs:1014` sits immediately adjacent to the env-var names
  `TERM_PROGRAM  KITTY_WINDOW_ID  SSH_CONNECTION  SSH_TTY  STY`.
- `HandoffRuntimeState: TERM_PROGRAM KITTY_WINDOW_ID wezterm` — herdr keys kitty
  capability off `TERM_PROGRAM` / `KITTY_WINDOW_ID` (kitty family + wezterm).
- herdr's own core parses/emits kitty graphics (`src/kitty_graphics.rs`,
  `processed kitty graphics sequence`, ghostty-vt `terminal.kitty.graphics`).

So: attaching from ghostty → child env has `TERM_PROGRAM=ghostty` → herdr's
client classifies the outer terminal as graphics-capable → forwards `_G`.
Our node-pty child was spawned as a bare `TERM=xterm-256color` with **no**
`TERM_PROGRAM` / `KITTY_WINDOW_ID`, and WITH `SSH_*` inherited (the server is
reached over SSH). herdr therefore classified the outer terminal as
NON-graphics-capable and stripped the APC before it ever reached restty.

## Why not restty / transport (hypotheses 2–4 ruled out)
- restty DOES implement the kitty graphics protocol: `dist/wasm/runtime/kitty`,
  `runtime/create-runtime/kitty-render-runtime*`, `kitty-image-cache*`,
  `pty/kitty-media`. No init option is required; the WASM VT parses `_G`.
- `forwardTerminalReplies` defaults **true** (dist/runtime/core/config.d.ts):
  restty writes terminal-generated replies back through the PTY transport, so a
  query round-trip would be answered. Our tapped transport
  (createTappedWsTransport) only wraps `onData`; it leaves `sendInput` / resize
  / reply paths intact, so no reply path is broken.
- restty decodes binary WS frames with a **streaming** TextDecoder
  (dist/pty/pty.d.ts `decodePtyBinary(..., stream)`), so our same-tick
  coalescing / arbitrary byte-boundary splitting cannot corrupt a split APC.
- herdr doesn't gate on a query anyway (see root cause), so the round-trip
  wasn't the deciding factor.

## Fix (server/src/pty.ts, startPty env)
Make the attach child look like a kitty-graphics-capable, local outer terminal —
which is truthful, because restty on the far end genuinely renders `_G`:
- set `TERM_PROGRAM = "ghostty"` (override: `FAMILIAR_ATTACH_TERM_PROGRAM`)
- set `KITTY_WINDOW_ID = "1"` (override: `FAMILIAR_ATTACH_KITTY_WINDOW_ID`)
- drop inherited outer-context markers `SSH_CONNECTION`, `SSH_TTY`, `SSH_CLIENT`,
  `STY` so herdr doesn't treat the outer terminal as a remote/multiplexer where
  it should suppress graphics.
- `TERM` stays `xterm-256color` for terminfo safety — `xterm-kitty` /
  `xterm-ghostty` terminfo entries are NOT installed on this host, and herdr
  keys off the env markers, not `$TERM`. (Verified: `infocmp xterm-ghostty`
  and `xterm-kitty` both MISSING here.)

## What Kevin should see after restart
Restart the familiar server (so pty.ts re-spawns attach children with the new
env). Open the browser terminal fresh (new attach). The teal familiar mark
should render via kitty graphics in the browser, matching the ghostty path. The
ASCII pseudodragon fallback only appears if the image path can't run at all.

## Needs live browser verification
Cannot render headless. Confirm in a real browser that (a) the mark image
appears (not the ASCII dragon), and (b) nothing regressed in mouse/emoji/probe.
If herdr STILL strips graphics, capture `HERDR_LOG=herdr=debug` around
`src/client/mod.rs:1014` to see the exact capability decision and adjust the
env signals (the two are override-able via FAMILIAR_ATTACH_* without a rebuild).
