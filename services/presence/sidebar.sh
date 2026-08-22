#!/usr/bin/env bash
# Familiar viewer sidebar. Render the mark with kitty graphics when possible,
# then remain resident so tmux always has a stable chrome pane.
set -u

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
REPO=${FAMILIAR_REPO:-$(CDPATH='' cd -- "$HERE/../.." && pwd -P)}
MARK=${FAMILIAR_SIDEBAR_MARK:-$REPO/assets/familiar-mark.svg}
ACCENT=${FAMILIAR_SIDEBAR_ACCENT:-#5ad4e6}
TMP=''
MODE=text

cleanup() {
  printf '\033[?25h'
  [ -z "$TMP" ] || rm -rf -- "$TMP"
}
trap cleanup EXIT
trap 'exit 0' INT TERM
printf '\033[?25l'

prepare_mark() {
  command -v rsvg-convert >/dev/null 2>&1 || return 1
  command -v base64 >/dev/null 2>&1 || return 1
  [ -r "$MARK" ] || return 1
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/familiar-sidebar.XXXXXX") || return 1
  sed "s/currentColor/$ACCENT/g" "$MARK" > "$TMP/mark.svg" || return 1
  rsvg-convert -w 256 -h 256 "$TMP/mark.svg" -o "$TMP/mark.png" >/dev/null 2>&1 || return 1
  [ -s "$TMP/mark.png" ]
}

send_mark() {
  local data total offset=0 chunk first=1 more
  data=$(base64 -w0 "$TMP/mark.png" 2>/dev/null || base64 "$TMP/mark.png" | tr -d '\n')
  [ -n "$data" ] || return 1
  total=${#data}
  printf '\033[2J\033[H\033[2;7H'
  while [ "$offset" -lt "$total" ]; do
    chunk=${data:$offset:4096}
    offset=$((offset + 4096))
    if [ "$offset" -lt "$total" ]; then more=1; else more=0; fi
    if [ "$first" -eq 1 ]; then
      printf '\033_Gf=100,a=T,c=16,r=8,m=%d;%s\033\\' "$more" "$chunk"
      first=0
    else
      printf '\033_Gm=%d;%s\033\\' "$more" "$chunk"
    fi
  done
  printf '\033[11;7H\033[1;38;2;90;212;230mF A M I L I A R\033[0m'
}

send_text() {
  printf '\033[2J\033[H\n\n  \033[1;38;2;90;212;230m      familiar\033[0m'
}

if prepare_mark; then MODE=kitty; fi
render() {
  if [ "$MODE" = kitty ]; then send_mark || { MODE=text; send_text; }
  else send_text
  fi
}
trap render WINCH
render

# A slow repaint also makes kitty images visible to clients which attach after
# the original APC transmission. WINCH provides the immediate resize path.
while :; do
  sleep 45 & wait $! || true
  render
done
