#!/usr/bin/env bash
set -euo pipefail

# The sidebar PTY is a tiny live surface, not a managed Herdr pane. Keep the
# process alive so the pseudodragon survives redraws. Its only motion is a rare,
# irregular blink: alive enough to notice, infrequent enough not to perform.
printf '\033[?25l'
trap 'printf "\033[?25h"' EXIT
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

while true; do
  sleep "$((180 + RANDOM % 421))"
  printf '\033[4;10H(- -)'
  sleep 0.12
  printf '\033[4;10H(o o)'
done
