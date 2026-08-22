#!/usr/bin/env bash
set -euo pipefail
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
PRESENCE=${PRESENCE:-$HERE/presence.sh}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/familiar-presence-test.XXXXXX")
cleanup() {
  local sock
  for sock in "$TMP"/*/tmux.sock; do
    [ ! -S "$sock" ] || tmux -S "$sock" kill-server 2>/dev/null || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT
pass=0
ok() { pass=$((pass + 1)); printf 'ok %d - %s\n' "$pass" "$*"; }
fail() { printf 'not ok - %s\n' "$*" >&2; exit 1; }

FAKE="$TMP/fake-worker.sh"
cat >"$FAKE" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$$" >> "$WORKER_PIDS"
trap 'exit 0' TERM INT
while :; do read -r -t 1 _ || true; done
EOF
chmod 700 "$FAKE"

state="$TMP/main"; socket="$state/tmux.sock"; pids="$state/pids"
BASH_BIN=$(command -v bash)
runp() { FAMILIAR_PRESENCE_STATE_DIR="$state" FAMILIAR_PRESENCE_SOCKET="$socket" FAMILIAR_PRESENCE_COMMAND="exec $BASH_BIN $FAKE" WORKER_PIDS="$pids" bash "$PRESENCE" "$@"; }

# A hostile default config would create this file if inherited.
home="$TMP/home"; mkdir -m 700 "$home"
printf 'run-shell "touch %s"\nset -g status on\n' "$TMP/hostile-loaded" > "$home/.tmux.conf"
HOME="$home" runp ensure >/dev/null
[ ! -e "$TMP/hostile-loaded" ] || fail "user config leaked"
[ "$(tmux -S "$socket" show-options -gv status)" = off ] || fail "status chrome enabled"
[ "$(tmux -S "$socket" show-options -gv pane-border-status)" = off ] || fail "pane border chrome enabled"
[ "$(tmux -S "$socket" show-options -gv prefix)" = C-b ] || fail "ordinary prefix unavailable"
ok "explicit config excludes hostile user config and removes chrome"

# Viewer creation is idempotent and its options do not alter Presence.
runp ensure-viewer >/dev/null
pane_ids=$(tmux -S "$socket" list-panes -t viewer:0 -F '#{pane_id}' | sort)
runp ensure-viewer >/dev/null
[ "$(tmux -S "$socket" list-panes -t viewer:0 -F '#{pane_id}' | sort)" = "$pane_ids" ] \
  || fail "idempotent viewer ensure replaced panes"
[ "$(tmux -S "$socket" list-panes -t viewer:0 | wc -l)" -eq 2 ] || fail "viewer does not have two panes"
[ "$(tmux -S "$socket" show-options -v -t viewer prefix)" = None ] || fail "viewer prefix enabled"
[ "$(tmux -S "$socket" show-options -v -t viewer mouse)" = off ] || fail "viewer captures mouse"
[ "$(tmux -S "$socket" show-options -Av -t presence prefix)" = C-b ] || fail "viewer policy changed Presence prefix"
[ "$(tmux -S "$socket" show-window-options -v -t viewer:0 allow-passthrough)" = on ] \
  || fail "viewer passthrough disabled"
ok "viewer creation is idempotent and options are session-scoped"

# A headless window resize fires the lock hook and restores a disturbed width.
tmux -S "$socket" resize-pane -t viewer:0.0 -x 40
tmux -S "$socket" resize-window -t viewer:0 -x 121 -y 30
for _ in $(seq 1 20); do
  [ "$(tmux -S "$socket" display-message -p -t viewer:0.0 '#{pane_width}')" = 28 ] && break
  sleep .05
done
[ "$(tmux -S "$socket" display-message -p -t viewer:0.0 '#{pane_width}')" = 28 ] \
  || fail "sidebar width was not restored after resize"
ok "viewer resize hook pins sidebar at 28 columns"

# A failed renderer supervisor leaves a dead pane, then the session hook
# respawns the sidebar command without needing another viewer attach.
tmux -S "$socket" respawn-pane -k -t viewer:0.0 'exit 7'
for _ in $(seq 1 20); do
  sidebar_state=$(tmux -S "$socket" display-message -p -t viewer:0.0 '#{pane_dead}:#{pane_start_command}')
  case "$sidebar_state" in 0:*run-sidebar*) break ;; esac
  sleep .05
done
case "$sidebar_state" in 0:*run-sidebar*) ;; *) fail "sidebar was not respawned: $sidebar_state" ;; esac
ok "dead sidebar command is respawned"

main_start=$(tmux -S "$socket" display-message -p -t viewer:0.1 '#{pane_start_command}')
case "$main_start" in
  *'TMUX='*'tmux -S '*'attach-session -t presence'*) ;;
  *) fail "unexpected nested attach command: $main_start" ;;
esac
ok "viewer main pane clears TMUX and attaches to Presence"

pid=$(tail -1 "$pids")
kill -0 "$pid"
# Attach under a disposable pseudo-terminal; timeout kills only the client.
set +e
timeout 0.5 script -qec "tmux -S '$socket' attach-session -t presence" /dev/null >/dev/null 2>&1
set -e
kill -0 "$pid" || fail "viewer detach killed worker"
set +e
timeout 0.5 script -qec "tmux -S '$socket' attach-session -t presence" /dev/null >/dev/null 2>&1
set -e
[ "$(tail -1 "$pids")" = "$pid" ] || fail "reattach replaced worker"
ok "viewer detach and reattach preserve exact worker pid"

# Concurrent ensure is serialized and does not duplicate the worker.
for _ in 1 2 3 4 5 6; do runp ensure >/dev/null & done
wait
[ "$(sort -u "$pids" | wc -l)" -eq 1 ] || fail "concurrent ensure duplicated worker"
ok "concurrent ensure yields one worker"

# A dead pane remains, then ensure safely respawns exactly once.
kill -TERM "$pid"
for _ in $(seq 1 50); do [ "$(tmux -S "$socket" display -pt presence:0.0 '#{pane_dead}')" = 1 ] && break; sleep .05; done
runp ensure >/dev/null
newpid=$pid
for _ in $(seq 1 50); do newpid=$(tail -1 "$pids"); [ "$newpid" != "$pid" ] && break; sleep .05; done
if [ "$newpid" = "$pid" ] || ! kill -0 "$newpid"; then fail "dead pane not recovered"; fi
ok "dead pane is recovered"

# Missing session on the still-owned server is recovered without disturbing a
# diagnostic session which happens to share this owned server.
tmux -S "$socket" new-session -d -s diagnostic 'read -r -t 30 _ || true'
tmux -S "$socket" kill-session -t presence
runp ensure >/dev/null
kill -0 "$(tail -1 "$pids")" || fail "missing session not recovered"
tmux -S "$socket" has-session -t diagnostic || fail "diagnostic session was disturbed"
ok "stale/missing session is recovered"

# Neither default socket nor another explicit server is touched.
other="$TMP/other.sock"
tmux -S "$other" -f /dev/null new-session -d -s unrelated 'sleep 30'
runp stop
tmux -S "$other" has-session -t unrelated
[ ! -S "$socket" ] || fail "owned socket survived stop"
tmux -S "$other" kill-server
ok "explicit stop kills only owned server"

# Unsafe path handling.
unsafe="$TMP/unsafe"; mkdir "$unsafe.real"; ln -s "$unsafe.real" "$unsafe"
if FAMILIAR_PRESENCE_STATE_DIR="$unsafe" FAMILIAR_PRESENCE_SOCKET="$unsafe/tmux.sock" bash "$PRESENCE" ensure >/dev/null 2>&1; then fail "symlink state accepted"; fi
ok "symlink state is rejected"

# Server source contract: default browser PTY uses the Viewer entrypoint and
# keeps FAMILIAR_ATTACH_CMD only as an override.
if [ -z "${SKIP_BROWSER_CONTRACT:-}" ]; then
  grep -q 'args: \["viewer"\]' "$HERE/../gateway/src/pty.ts" || fail "browser default is not Viewer attach"
  grep -q 'FAMILIAR_ATTACH_CMD' "$HERE/../gateway/src/pty.ts" || fail "browser test override missing"
  grep -q 'new URL("../../presence/presence.sh"' "$HERE/../gateway/src/pty.ts" \
    || fail "browser Presence fallback path is not gateway-relative"
  ok "browser attach command points at Viewer"
fi

printf '1..%d\n' "$pass"
