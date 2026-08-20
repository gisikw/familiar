# Server extraction — settlement

## WS-echo devShell failure: root cause
NOT interactive-shell (`-i`) behavior as the prior agent guessed. node-pty
spawns via `execvp()`, which resolves a **bare** command name (`bash`) against
the *child's* PATH. In a pure/stripped devShell that PATH is empty, so the
attach child dies with `execvp(3) failed.: No such file or directory` and the
WS bridge never echoes. In the normal `.#server` devShell PATH is populated, so
the same test passed — hence the "inside vs outside" confusion.

Reproduced with a probe: absolute-path bash worked in ALL variants
(interactive/non-interactive, normal/stripped PATH); bare `bash` failed only
under stripped PATH.

## Fix
`server/scripts/smoke.sh`: `FAMILIAR_ATTACH_CMD="$(command -v bash) --norc"`
(absolute path sidesteps execvp PATH lookup; `-i` dropped to avoid job-control
noise with no controlling tty). Production default (`herdr session attach`) is
unchanged and must be on the services-pane PATH.

## Smoke results (server/scripts/smoke.sh, .#server devShell) — 15/15 PASS
health; /terminal HTML; / HTML; restty asset; font asset; emoji.json; traversal
guarded(404); SSE session event; ingest→SSE round-trip; history replay on
reattach; session re-mint clears history; submit→/relay; cancel 204;
cancel→/relay; **WS PTY echo**. Ran 5x pre-fix (normal env) green; post-fix green.

## Other checks
- `bash -n familiar.sh` OK.
- All `server/src/*.ts` and `extensions/subscriber/*.ts` pass `node
  --experimental-transform-types --check`. No `tsc` in devShell (design is
  build-free / native type-stripping).
- subscriber/protocol.ts re-exports constants+types from
  `../../server/src/protocol.ts` (single source of truth); all 7 constants exist.
- No dangling refs to deleted server.ts/hub.ts/audio.ts.

## Commits
- 6c6a471 checkpoint (uncommitted builder tree)
- 3799c1f smoke PTY attach fix

## Needs live verification
Real `herdr session attach familiar` on services-pane PATH; browser WASM/font
(OpenMoji) rendering at /terminal; macOS.
