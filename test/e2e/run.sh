#!/usr/bin/env bash
# Real gateway -> native viewer -> isolated Presence -> Chromium pixel smoke.
set -euo pipefail
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
HERE="$ROOT/test/e2e"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/familiar-e2e.XXXXXX")
STATE="$TMP/presence"
SOCKET="$STATE/tmux.sock"
ARTIFACTS=${FAMILIAR_E2E_ARTIFACTS:-$HERE/artifacts}
GATEWAY_LOG="$ARTIFACTS/gateway.log"
mkdir -p "$ARTIFACTS"
rm -rf "$ARTIFACTS/playwright"
rm -f "$ARTIFACTS"/*.png "$ARTIFACTS"/*.bin "$ARTIFACTS"/*.json "$ARTIFACTS"/*.txt "$GATEWAY_LOG"
GATEWAY_PID=
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  [ -z "$GATEWAY_PID" ] || kill "$GATEWAY_PID" 2>/dev/null || true
  [ ! -S "$SOCKET" ] || tmux -S "$SOCKET" kill-server 2>/dev/null || true
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT INT TERM

for tool in familiar-gateway playwright tmux kitten magick node curl; do
  command -v "$tool" >/dev/null || { echo "e2e: missing $tool; use: nix develop .#e2e" >&2; exit 2; }
done
FAMILIAR_VIEWER_BIN=${FAMILIAR_VIEWER_BIN:-$(command -v familiar-viewer || true)}
[ -n "$FAMILIAR_VIEWER_BIN" ] && command -v "$FAMILIAR_VIEWER_BIN" >/dev/null \
  || { echo "e2e: set FAMILIAR_VIEWER_BIN or use nix develop .#e2e" >&2; exit 2; }

# A shell, not Familiar/pi, is the fixture payload. presence.sh still owns the
# exact isolated session/config lifecycle used in production.
export FAMILIAR_PRESENCE_STATE_DIR="$STATE"
export FAMILIAR_PRESENCE_SOCKET="$SOCKET"
export FAMILIAR_PRESENCE_SESSION=presence
export FAMILIAR_PRESENCE_COMMAND='exec env PS1= bash --noprofile --norc -i'
export FAMILIAR_PRESENCE_CTL="$ROOT/services/presence/presence.sh"
export FAMILIAR_VIEWER_BIN
export FAMILIAR_MARK_PNG="$ROOT/assets/familiar-mark.png"
export FAMILIAR_GRAPHICS_MODE=kitty
unset FAMILIAR_ATTACH_CMD
bash "$FAMILIAR_PRESENCE_CTL" ensure >/dev/null

# Pure-magenta fixture: unlike terminal text/theme colors it has an unambiguous
# screenshot signature. ImageMagick comes from the e2e shell.
magick -size 64x64 xc:'#ff00ff' "$TMP/magenta.png"
PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
export FAMILIAR_SERVER_HOST=127.0.0.1 FAMILIAR_SERVER_PORT="$PORT"
export FAMILIAR_E2E_URL="http://127.0.0.1:$PORT"
export FAMILIAR_E2E_SOCKET="$SOCKET"
export FAMILIAR_E2E_IMAGE="$TMP/magenta.png"
export FAMILIAR_E2E_ARTIFACTS="$ARTIFACTS"
familiar-gateway >"$GATEWAY_LOG" 2>&1 & GATEWAY_PID=$!
for _ in $(seq 1 100); do
  curl -fsS "$FAMILIAR_E2E_URL/health" >/dev/null 2>&1 && break
  kill -0 "$GATEWAY_PID" 2>/dev/null || { cat "$GATEWAY_LOG" >&2; exit 1; }
  sleep .1
done
curl -fsS "$FAMILIAR_E2E_URL/health" >/dev/null

set +e
playwright test --config "$HERE/playwright.config.mjs" "$HERE/terminal.spec.mjs"
status=$?
set -e
if [ -f "$ARTIFACTS/kitty-result.json" ]; then
  node -e 'const r=require(process.argv[1]); console.log(`KITTY REGRESSION: ${r.pixels && r.bytes ? "PASS" : "FAIL"}; translated APC bytes=${r.bytes}; magenta pixels=${r.magentaPixels}`)' "$ARTIFACTS/kitty-result.json"
fi
exit "$status"
