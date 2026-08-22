# Restructure notes

## Old → new

- `client/` → `apps/desktop/`
- `server/` → `services/gateway/` (the existing code is entirely interaction ingress, relay/delivery, and terminal projection; no supervisor/bootstrap code existed to split into `services/server/`)
- `extensions/` → `integrations/pi/extensions/`
- `patches/` → `integrations/pi/patches/`
- `identity/`, `skills/`, `assets/`, `scripts/`, and shared `test/` remain at repository root as directed.

The initially empty boundaries were subsequently implemented: `services/server/`, the three shared `packages/`, and `agents/` now contain independently buildable modules. A mobile application remains deferred.

## References updated

- `familiar.sh`: pi settings extension root, gateway working directory/dev shell/pane role, desktop working directory, and worklist protocol documentation path.
- Root `flake.nix`: gateway dev shell/name and desktop/gateway comments.
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

## Integration

- The root flake now follows each deployable module flake and exposes `familiar-server`, `familiar-llm`, `familiar-stt`, `familiar-tts`, `familiar-gateway`, `familiar-desktop`, `familiar-agents`, `familiar-agents-service`, and `familiar-agents-supervisor`. `nix build .#` builds the server supervisor default.
- `services/server/familiar-server.toml.example` is the canonical source-tree five-child deployment. It starts the four packaged services through the root flake, controls Presence through `services/presence/presence.sh`, probes LLM/STT at `/ready`, TTS at `/readyz`, and the gateway at its actual `/health` endpoint. Supervisor shutdown preserves Presence by default.
- `./familiar.sh server` runs that canonical supervisor configuration (override with `FAMILIAR_SERVER_CONFIG` or `[server] config`). `./familiar.sh agents <args...>` passes through to the packaged `familiar-agents` CLI; `[agents] endpoint` and `[agents] host` become the CLI/extension environment.
- `integrations/pi/extensions/agents/index.ts` stages the five CLI-backed tools `agents_dispatch`, `agents_status`, `agents_await`, `agents_respond`, and `agents_cancel`. The CLI gained the blocking `await` primitive used by the bridge.
- Enabling that agents extension is deliberately deferred. The live extension list in `familiar.sh` is now explicit and preserves the previous set while excluding `agents`; the CLI is already in the pi environment for a later controlled enablement.

Commands now available:

```sh
nix build .#                              # default: familiar-server
nix build .#familiar-server
nix build .#familiar-agents-service .#familiar-agents-supervisor .#familiar-agents
./familiar.sh server
./familiar.sh agents --json list
```

## Ambiguities and risks

- The original `server/` correctly moved to `services/gateway/`; the new supervisor is a separate implementation in `services/server/`.
- Shared integration tests remain in `test/`; module-specific tests stayed with the moved gateway and pi extensions.
- Desktop Electron selftest was not run because it requires Electron and, for its live-page path, a display/running gateway. No desktop build/typecheck script exists.
- Gateway `npm install` succeeded and `node-pty` built, but its existing vendor script reported that the already-absent `apps/desktop/src/renderer/{fonts,vendor}` sources could not be copied. The tracked gateway web assets and restty bundle behavior were otherwise exercised; restoring those optional font/emoji source assets is outside this path-only restructure.
- Interactive stack startup was deliberately not attempted. Static launch tracing is consistent: `familiar.sh` → `services/presence/presence.sh` → `familiar.sh pi` → `integrations/pi/extensions`, while gateway PTYs attach through that Presence controller.
