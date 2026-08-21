# Restructure notes

## Old → new

- `client/` → `apps/desktop/`
- `server/` → `services/gateway/` (the existing code is entirely interaction ingress, relay/delivery, and terminal projection; no supervisor/bootstrap code existed to split into `services/server/`)
- `extensions/` → `integrations/pi/extensions/`
- `patches/` → `integrations/pi/patches/`
- `identity/`, `skills/`, `assets/`, `scripts/`, and shared `test/` remain at repository root as directed.

No empty `services/server/`, `packages/`, mobile, or agent boundaries were created.

## References updated

- `familiar.sh`: pi settings extension root, gateway working directory/dev shell/pane role, desktop working directory, and worklist protocol documentation path.
- Root `flake.nix`: Herdr patch path, gateway dev shell/name, and desktop/gateway comments.
- `services/presence/test.sh`: gateway source location and gateway-relative Presence fallback assertion. `services/presence/presence.sh` itself remains repository-root-relative and still executes `familiar.sh pi`.
- `services/gateway/`: package identity, README/run path, desktop asset-vendoring path, protocol shim consumers, theme source comments, smoke/test commands, `.gitignore`, and the default Presence controller URL.
- `apps/desktop/`: root computation in the icon script, icon output and shared asset paths, gateway web icon destination, README layout, and launcher path.
- `integrations/pi/extensions/`: documentation/test command paths, repository-root calculations, explicit child-extension path tests, cold-process test import, and the subscriber protocol import to `services/gateway`.
- Root `README.md`, `docs/THEME.md`, `scripts/familiar-theme.sh`, and shared tests were updated for the new module paths.
- `test/run.sh` now starts the separately-homed gateway before exercising the subscriber/gateway integration.
- Added minimal flakes at `apps/desktop/flake.nix`, `services/gateway/flake.nix`, and `integrations/pi/flake.nix`.

## Verification

- Root, desktop, gateway, and pi-integration flakes evaluate with `nix flake show --no-write-lock-file`.
- 253 Bun unit tests passed across pi integrations and gateway code.
- Gateway/subscriber integration harness and zip checks passed after launching the gateway separately.
- Config, theme (17 checks), worklist ingress, and pi extension-loader smoke tests passed.
- Presence tmux adapter suite passed all 8 checks, including detach/reattach, recovery, isolation, and gateway attachment wiring.
- `bash -n` and `git diff --check` passed. There are no TypeScript typecheck/build scripts in the moved modules.

## Ambiguities and risks

- `services/server/` was intentionally not created: the old `server/` is overwhelmingly gateway-shaped and contains no supervisor/bootstrap implementation.
- Shared integration tests remain in `test/`; module-specific tests stayed with the moved gateway and pi extensions.
- Desktop Electron selftest was not run because it requires Electron and, for its live-page path, a display/running gateway. No desktop build/typecheck script exists.
- Gateway `npm install` succeeded and `node-pty` built, but its existing vendor script reported that the already-absent `apps/desktop/src/renderer/{fonts,vendor}` sources could not be copied. The tracked gateway web assets and restty bundle behavior were otherwise exercised; restoring those optional font/emoji source assets is outside this path-only restructure.
- Interactive stack startup was deliberately not attempted. Static launch tracing is consistent: `familiar.sh` → `services/presence/presence.sh` → `familiar.sh pi` → `integrations/pi/extensions`, while gateway PTYs attach through that Presence controller.
