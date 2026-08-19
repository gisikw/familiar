#!/usr/bin/env bash
set -euo pipefail

# The sidebar PTY is a tiny live surface, not a managed Herdr pane. Keep the
# process alive so the pseudodragon survives redraws. Its only motions are a
# rare, irregular blink and an even rarer tail flick: alive enough to notice,
# infrequent enough not to perform.
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

next_blink=$((SECONDS + 180 + RANDOM % 421))
next_tail_flick=$((SECONDS + 420 + RANDOM % 781))

while true; do
  if ((next_blink <= next_tail_flick)); then
    delay=$((next_blink - SECONDS))
    if ((delay > 0)); then
      sleep "$delay"
    fi
    printf '\033[4;10H(- -)'
    sleep 0.12
    printf '\033[4;10H(o o)'
    next_blink=$((SECONDS + 180 + RANDOM % 421))
  else
    delay=$((next_tail_flick - SECONDS))
    if ((delay > 0)); then
      sleep "$delay"
    fi
    printf '\033[4;20H.~>'
    sleep 0.16
    printf '\033[4;20H<~.'
    next_tail_flick=$((SECONDS + 420 + RANDOM % 781))
  fi
done
