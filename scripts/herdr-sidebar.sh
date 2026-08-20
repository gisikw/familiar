#!/usr/bin/env bash
set -euo pipefail

# The sidebar PTY is a tiny live surface, not a managed Herdr pane. Keep the
# process alive so the mark survives redraws.
#
# PRIMARY path: kitty graphics. Kevin validated kitty-protocol passthrough
# through the terminal stack (restty / libghostty-vt) before adopting it, so we
# assume the APC image transmit reaches a real terminal. We rasterize the
# familiar mark (assets/familiar-mark.svg) to a teal PNG on transparent and
# transmit it inline, sized in cells for the ~30-col sidebar.
#
# FALLBACK path: the original ASCII pseudodragon, with its rare blink and even
# rarer tail flick. Sentimentally kept, fully intact. We fall back only when the
# image path plainly can't work: no tty, a dumb/unset TERM, or the rasterizer /
# source SVG is missing. Worst case, nothing changed visually.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARK_SVG="$REPO/assets/familiar-mark.svg"
ACCENT="#32b08d"   # oklch(0.68 0.12 170) -> precise sRGB

printf '\033[?25l'
trap 'printf "\033[?25h"' EXIT

# --- ASCII fallback (unchanged charm) --------------------------------------
run_ascii() {
  cat <<'ART'


       ^       ^
      / \ :-: / \
     /-v (o o) v-\ <~.
     \ .- \_/ -. /   '
      \  /'''\  /   //
        |'.'.'\ ___\ \
         \' ' ' ' ' '/
          ("|")._\(."
           "" ""   "
      F A M I L I A R
ART
  local next_blink next_tail_flick delay
  next_blink=$((SECONDS + 180 + RANDOM % 421))
  next_tail_flick=$((SECONDS + 420 + RANDOM % 781))
  while true; do
    if ((next_blink <= next_tail_flick)); then
      delay=$((next_blink - SECONDS))
      ((delay > 0)) && sleep "$delay"
      printf '\033[4;10H(- -)'
      sleep 0.12
      printf '\033[4;10H(o o)'
      next_blink=$((SECONDS + 180 + RANDOM % 421))
    else
      delay=$((next_tail_flick - SECONDS))
      ((delay > 0)) && sleep "$delay"
      printf '\033[4;20H.~>'
      sleep 0.16
      printf '\033[4;20H<~.'
      next_tail_flick=$((SECONDS + 420 + RANDOM % 781))
    fi
  done
}

# --- kitty graphics primary path -------------------------------------------
# Can we even attempt the image path? Cheap, positive checks only.
can_image() {
  [ -t 1 ] || return 1
  case "${TERM:-}" in ""|dumb) return 1 ;; esac
  command -v rsvg-convert >/dev/null 2>&1 || return 1
  [ -r "$MARK_SVG" ] || return 1
  return 0
}

# Render the mark to a teal PNG on transparent. Sidebar is ~30 cols x 12 rows;
# a terminal cell is roughly 1:2 (w:h), so COLS=2*ROWS keeps the square mark
# square. 16x8 cells, centered (left pad ~7). Rasterize at generous px so it
# stays crisp on hi-dpi.
COLS=16
ROWS=8
render_png() {
  local tmp="$1"
  sed "s/currentColor/$ACCENT/g" "$MARK_SVG" > "$tmp/mark.svg" || return 1
  rsvg-convert -w 320 -h 320 "$tmp/mark.svg" -o "$tmp/mark.png" 2>/dev/null
}

# Transmit chunked base64 per the kitty protocol. a=T places at the cursor;
# c/r let the terminal scale the image to that many cells. Returns nonzero if
# base64 came out empty (treated as "image path failed").
transmit_png() {
  local png="$1" b64 total off=0 piece first=1
  b64="$(base64 -w0 "$png" 2>/dev/null || base64 "$png" | tr -d '\n')"
  [ -n "$b64" ] || return 1
  total=${#b64}
  while ((off < total)); do
    piece="${b64:off:4096}"
    off=$((off + 4096))
    if ((first)); then
      first=0
      if ((off < total)); then
        printf '\033_Gf=100,a=T,c=%d,r=%d,m=1;%s\033\\' "$COLS" "$ROWS" "$piece"
      else
        printf '\033_Gf=100,a=T,c=%d,r=%d,m=0;%s\033\\' "$COLS" "$ROWS" "$piece"
      fi
    elif ((off < total)); then
      printf '\033_Gm=1;%s\033\\' "$piece"
    else
      printf '\033_Gm=0;%s\033\\' "$piece"
    fi
  done
  return 0
}

run_kitty() {
  local tmp
  tmp="$(mktemp -d)"
  if ! render_png "$tmp"; then
    rm -rf "$tmp"
    return 1
  fi
  printf '\033[2J\033[H\n'          # clear, home, one row of top padding
  printf '\033[2;8H'                # row 2, centered column for a 16-cell image
  if ! transmit_png "$tmp/mark.png"; then
    rm -rf "$tmp"
    printf '\033[2J\033[H'
    return 1
  fi
  rm -rf "$tmp"
  printf '\033[11;8HF A M I L I A R'
  # Herdr replays text state to late-attaching clients, but a kitty APC image
  # transmitted before a client attached is not part of the replayed grid — the
  # experimental kitty path forwards live sequences only. Re-transmit on a slow
  # loop so any client attached at the time sees the mark within a minute.
  local retmp
  while true; do
    sleep 45
    retmp="$(mktemp -d)"
    if render_png "$retmp"; then
      printf '\033[2;8H'
      transmit_png "$retmp/mark.png" || true
    fi
    rm -rf "$retmp"
  done
}

if can_image && run_kitty; then
  :   # image path took over and blocks forever
else
  run_ascii
fi
