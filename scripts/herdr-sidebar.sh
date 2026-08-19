#!/usr/bin/env bash
set -euo pipefail

# The sidebar PTY is a tiny live surface, not a managed Herdr pane. Keep the
# process alive so the pseudodragon survives redraws; future status/color work
# can replace this static loop without changing Herdr's configuration.
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

while sleep 3600; do :; done
