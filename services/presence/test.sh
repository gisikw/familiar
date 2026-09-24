#!/usr/bin/env bash
set -euo pipefail
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
PRESENCE=${PRESENCE:-$HERE/presence.sh}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/familiar-presence-test.XXXXXX")
state="$TMP/state"; socket="$state/tmux.sock"; pids="$state/pids"; project="$TMP/project"
cleanup() {
  [ ! -S "$socket" ] || tmux -S "$socket" kill-server 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
mkdir "$project"
pass=0
ok() { pass=$((pass + 1)); printf 'ok %d - %s\n' "$pass" "$*"; }
fail() { printf 'not ok - %s\n' "$*" >&2; exit 1; }

fake="$TMP/worker.sh"
cat > "$fake" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$$" >> "$WORKER_PIDS"
trap 'exit 0' TERM INT
while :; do sleep 1; done
EOF
chmod 700 "$fake"
runp() {
  FAMILIAR_PRESENCE_STATE_DIR="$state" FAMILIAR_PRESENCE_SOCKET="$socket" \
  FAMILIAR_PRESENCE_CWD="$project" FAMILIAR_PRESENCE_COMMAND="exec $fake" \
  WORKER_PIDS="$pids" bash "$PRESENCE" "$@"
}

home="$TMP/home"; mkdir "$home"
printf 'run-shell "touch %s"\n' "$TMP/hostile" > "$home/.tmux.conf"
HOME="$home" runp start
[ ! -e "$TMP/hostile" ] || fail 'user tmux config leaked'
[ "$(tmux -S "$socket" list-sessions -F '#{session_name}')" = presence ] || fail 'wrong session'
[ "$(tmux -S "$socket" display-message -p -t presence '#{pane_current_path}')" = "$project" ] || fail 'working directory lost'
pid=$(cat "$state/pi.pid")
for _ in $(seq 1 50); do [ -s "$pids" ] && break; sleep .02; done
[ "$pid" = "$(tmux -S "$socket" display-message -p '#{pid}')" ] && kill -0 "$pid" || fail 'PID file does not track the tmux server'
worker=$(tail -1 "$pids")
if runp start >/dev/null 2>&1; then fail 'second start was accepted'; fi
if runp ensure >/dev/null 2>&1; then fail 'ensure was accepted'; fi
ok 'start creates one isolated pane and publishes its PID'

record="$TMP/viewer"
viewer="$TMP/viewer.sh"
cat > "$viewer" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$FAMILIAR_PRESENCE_SOCKET" > "$VIEWER_RECORD"
exit 23
EOF
chmod 700 "$viewer"
set +e
VIEWER_RECORD="$record" FAMILIAR_VIEWER_BIN="$viewer" runp viewer
status=$?
set -e
[ "$status" -eq 23 ] && [ "$(cat "$record")" = "$socket" ] || fail 'viewer contract failed'
[ "$(tail -1 "$pids")" = "$worker" ] || fail 'viewer replaced worker'
ok 'viewer only attaches to the existing runtime'

kill -TERM "$worker"
for _ in $(seq 1 50); do ! kill -0 "$pid" 2>/dev/null && break; sleep .05; done
! kill -0 "$pid" 2>/dev/null || fail 'tmux server outlived its only worker'
sleep .1
[ "$(wc -l < "$pids")" -eq 1 ] || fail 'worker respawned without systemd'
if runp status --quiet; then fail 'dead worker reported running'; fi
if VIEWER_RECORD="$record" FAMILIAR_VIEWER_BIN="$viewer" runp viewer >/dev/null 2>&1; then fail 'viewer started dead runtime'; fi
ok 'worker exit stays down and attach paths do not restart it'

runp start
newpid=$(cat "$state/pi.pid")
[ "$newpid" != "$pid" ] && kill -0 "$newpid" || fail 'unit-style restart did not create a new worker'
runp stop
[ ! -S "$socket" ] && [ ! -e "$state/pi.pid" ] || fail 'stop left runtime state'
ok 'explicit start models systemd restart and stop is socket-scoped'

unsafe="$TMP/unsafe"; mkdir "$unsafe.real"; ln -s "$unsafe.real" "$unsafe"
if FAMILIAR_PRESENCE_STATE_DIR="$unsafe" FAMILIAR_PRESENCE_SOCKET="$unsafe/tmux.sock" bash "$PRESENCE" start >/dev/null 2>&1; then fail 'symlink state accepted'; fi
ok 'unsafe state path is rejected'

if grep -qE 'ensurePresence|spawnSync\(controller' "$HERE/../gateway/src/pty.ts"; then
  fail 'gateway still owns Presence lifecycle'
fi
ok 'gateway contains no Presence start or recovery path'

printf '1..%d\n' "$pass"
