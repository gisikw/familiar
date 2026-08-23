# Browser terminal pixel regression

This harness exercises the production chain: headless Chromium/restty -> gateway
WebSocket/node-pty -> `familiar-viewer` -> an isolated Presence tmux session.
It never uses `FAMILIAR_ATTACH_CMD` and never touches repository/user Presence
state.

```sh
nix develop .#e2e -c ./test/e2e/run.sh
```

The Nix shell supplies Playwright and its matching Chromium through
`playwright-driver.browsers`; no `npx` browser download occurs. Set
`FAMILIAR_E2E_ARTIFACTS` to change the output directory. The runner always
tears down the gateway, viewer clients, private tmux server, and temporary
state.

Tests assert the sidebar mark by its asset's dominant teal pixel signature.
restty renders terminal cells into a GPU canvas and exposes no text DOM, so the
content smoke asserts a main-region screenshot pixel delta after writing a
high-contrast marker. The Kitty test sends a pure-magenta PNG from inside tmux
using `kitten icat --transfer-mode=stream`, saves both a screenshot and raw
WebSocket streams, and identifies viewer-translated child APCs by their raw
`f=24`/`f=32` upload header (the sidebar mark is an `f=100` PNG).

The Kitty pixel failure is currently a **non-fatal known issue**. `run.sh`
prints `XFAIL` when pixels are absent and loudly prints `PASS (bug did not
reproduce)` if they appear. See `artifacts/kitty-result.json` for byte-vs-pixel
localization.
