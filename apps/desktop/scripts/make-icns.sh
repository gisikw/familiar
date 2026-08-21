#!/usr/bin/env bash
# make-icns.sh — build the familiar app-icon deliverables from assets/icon.svg.
#
# Rasterizes the 1024x1024 master into the PNG set macOS/Electron want, an
# apple-touch-icon for the served page, and (where tooling exists) assembles a
# .icns. Two assembly backends:
#   * png2icns (libicns)  — works headlessly on Linux/CI. Preferred here.
#   * iconutil (macOS)    — used automatically when png2icns is unavailable
#                           (e.g. running this on Kevin's Mac).
#
# Requires rsvg-convert (librsvg). Under nix:  nix shell nixpkgs#librsvg
# nixpkgs#libicns -c ./apps/desktop/scripts/make-icns.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MASTER="$ROOT/assets/icon.svg"
# The touch icon uses the full-bleed master (no Apple-grid margin): iOS applies
TOUCH_MASTER="$ROOT/assets/icon-touch.svg"
# its own corner mask, so a margined icon would look undersized on the home
# screen. icon-touch.svg is the pre-margin snapshot of icon.svg.
OUT="$ROOT/assets/icons"          # PNG set (gitignored build output)
WEB="$ROOT/services/gateway/web"            # apple-touch-icon lands here
ICNS="$ROOT/apps/desktop/build/icon.icns"

[ -f "$MASTER" ] || { echo "missing master: $MASTER" >&2; exit 1; }

# rsvg-convert is required. Try PATH, then a nix fallback shim.
rsvg() {
  if command -v rsvg-convert >/dev/null 2>&1; then rsvg-convert "$@";
  elif command -v nix >/dev/null 2>&1; then nix run nixpkgs#librsvg -- "$@";
  else echo "need rsvg-convert (librsvg)" >&2; exit 1; fi
}

mkdir -p "$OUT" "$(dirname "$ICNS")"

SIZES="16 32 48 64 128 256 512 1024"
echo "rasterizing PNG set -> $OUT"
for s in $SIZES; do
  rsvg -w "$s" -h "$s" "$MASTER" -o "$OUT/icon_${s}.png"
done

# apple-touch-icon: 180x180, non-transparent (iOS composites on black otherwise;
# our squircle already fills the frame edge-to-edge so this is fine).
echo "apple-touch-icon -> $WEB/apple-touch-icon.png"
rsvg -w 180 -h 180 "${TOUCH_MASTER:-$MASTER}" -o "$WEB/apple-touch-icon.png"

# --- assemble .icns --------------------------------------------------------
if command -v png2icns >/dev/null 2>&1 || command -v nix >/dev/null 2>&1 \
   && ! command -v iconutil >/dev/null 2>&1; then
  echo "assembling $ICNS via png2icns (libicns)"
  # png2icns picks icns element types from each PNG's dimensions.
  PNGS=""
  for s in 16 32 48 128 256 512 1024; do PNGS="$PNGS $OUT/icon_${s}.png"; done
  if command -v png2icns >/dev/null 2>&1; then
    png2icns "$ICNS" $PNGS
  else
    nix run nixpkgs#libicns -- png2icns "$ICNS" $PNGS 2>/dev/null \
      || nix shell nixpkgs#libicns -c png2icns "$ICNS" $PNGS
  fi
elif command -v iconutil >/dev/null 2>&1; then
  # macOS path: build a .iconset then iconutil.
  echo "assembling $ICNS via iconutil (macOS)"
  SET="$(mktemp -d)/icon.iconset"; mkdir -p "$SET"
  rsvg -w 16   -h 16   "$MASTER" -o "$SET/icon_16x16.png"
  rsvg -w 32   -h 32   "$MASTER" -o "$SET/icon_16x16@2x.png"
  rsvg -w 32   -h 32   "$MASTER" -o "$SET/icon_32x32.png"
  rsvg -w 64   -h 64   "$MASTER" -o "$SET/icon_32x32@2x.png"
  rsvg -w 128  -h 128  "$MASTER" -o "$SET/icon_128x128.png"
  rsvg -w 256  -h 256  "$MASTER" -o "$SET/icon_128x128@2x.png"
  rsvg -w 256  -h 256  "$MASTER" -o "$SET/icon_256x256.png"
  rsvg -w 512  -h 512  "$MASTER" -o "$SET/icon_256x256@2x.png"
  rsvg -w 512  -h 512  "$MASTER" -o "$SET/icon_512x512.png"
  rsvg -w 1024 -h 1024 "$MASTER" -o "$SET/icon_512x512@2x.png"
  iconutil -c icns "$SET" -o "$ICNS"
else
  echo "no icns backend (png2icns/iconutil) — PNG set produced; run on Mac to get .icns" >&2
fi

echo "done."
