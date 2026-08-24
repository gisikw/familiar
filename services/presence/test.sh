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

# An owned config is the entire inner-session policy; user config cannot leak.
home="$TMP/home"; mkdir -m 700 "$home"
printf 'run-shell "touch %s"\nset -g status on\n' "$TMP/hostile-loaded" > "$home/.tmux.conf"
HOME="$home" runp ensure >/dev/null
[ ! -e "$TMP/hostile-loaded" ] || fail "user config leaked"
[ "$(tmux -S "$socket" list-sessions -F '#{session_name}')" = presence ] \
  || fail "ensure created a session other than presence"
[ "$(tmux -S "$socket" show-options -gv status)" = off ] || fail "inner status chrome enabled"
[ "$(tmux -S "$socket" show-options -gv prefix)" = C-b ] || fail "inner prefix unavailable"
[ "$(tmux -S "$socket" show-options -gv remain-on-exit)" = off ] || fail "dead panes linger"
[ "$(tmux -S "$socket" show-window-options -gv allow-passthrough)" = all ] \
  || fail "inner passthrough is not enabled"
[ "$(tmux -S "$socket" show-options -gv extended-keys)" = on ] || fail "extended keys disabled"
[ "$(tmux -S "$socket" show-options -gv mouse)" = on ] || fail "inner mouse arbitration disabled"
[ "$(tmux -S "$socket" show-options -gv mode-style)" = 'fg=#f7f1ff,bg=#525053' ] || fail "copy-mode selection is not themed"
[ "$(tmux -S "$socket" show-options -gv copy-mode-position-style)" = 'fg=#5ad4e6,bg=#222222' ] || fail "copy-mode position is not themed"
tmux -S "$socket" list-keys -T root PageUp | grep -Fq '#{alternate_on}' \
  || fail "PageUp alternate-screen arbitration missing"
case $(tmux -S "$socket" show-options -gv terminal-features) in
  *tmux\*:RGB:extkeys*ghostty\*:RGB:clipboard:ccolour:cstyle:focus:title:extkeys*) ;;
  *) fail "inner nested/direct terminal features missing" ;;
esac
# Truecolor (RGB) must be advertised for the direct/native attach TERM patterns
# so inner tmux passes the theme accent RGB SGR through instead of downgrading
# or dropping it (grey editor lines regression).
case $(tmux -S "$socket" show-options -gv terminal-features) in
  *xterm\*:RGB:*) ;;
  *) fail "inner terminal features do not advertise truecolor (RGB)" ;;
esac
ok "ensure creates only the isolated presence session with inner terminal policy"

pid=$(tail -1 "$pids")
kill -0 "$pid"

# The public viewer command must ensure Presence and then exec exactly the
# configured native binary, without manufacturing viewer argv.
record="$TMP/viewer-record"
viewer_stub="$TMP/viewer-stub.sh"
cat >"$viewer_stub" <<'EOF'
#!/usr/bin/env bash
{
  printf 'argc=%s\n' "$#"
  printf 'socket=%s\n' "${FAMILIAR_PRESENCE_SOCKET:-}"
  printf 'state=%s\n' "${FAMILIAR_PRESENCE_STATE_DIR:-}"
} > "$VIEWER_RECORD"
exit 23
EOF
chmod 700 "$viewer_stub"
set +e
VIEWER_RECORD="$record" FAMILIAR_VIEWER_BIN="$viewer_stub" runp viewer
viewer_status=$?
set -e
[ "$viewer_status" -eq 23 ] || fail "viewer did not preserve native binary exit status"
grep -Fxq 'argc=0' "$record" || fail "viewer passed arguments"
grep -Fxq "socket=$socket" "$record" || fail "viewer dropped Presence socket env"
grep -Fxq "state=$state" "$record" || fail "viewer dropped Presence state env"
[ "$(tmux -S "$socket" list-sessions -F '#{session_name}')" = presence ] || fail "viewer created an outer session"
ok "viewer execs FAMILIAR_VIEWER_BIN with no args and inherited runtime env"

stub_bin="$TMP/bin"; mkdir "$stub_bin"
cp "$viewer_stub" "$stub_bin/familiar-viewer"
rm -f "$record"
set +e
PATH="$stub_bin:$PATH" VIEWER_RECORD="$record" runp viewer
path_status=$?
set -e
if [ "$path_status" -ne 23 ] || ! grep -Fxq 'argc=0' "$record"; then
  fail "viewer did not resolve familiar-viewer from PATH"
fi
ok "viewer falls back to familiar-viewer on PATH"

missing_err="$TMP/missing-viewer.err"
if FAMILIAR_VIEWER_BIN="$TMP/absent-viewer" runp viewer 2>"$missing_err"; then
  fail "missing native viewer was accepted"
fi
if ! grep -Fq 'FAMILIAR_VIEWER_BIN' "$missing_err" \
  || ! grep -Fq 'familiar-viewer' "$missing_err"; then
  fail "missing-viewer error does not name both resolution choices"
fi
ok "viewer reports both native binary resolution choices"

# Exercise the SSH-facing command through a viewer process whose only job is
# to attach its child PTY to the inner session. Killing each disposable viewer
# must reap its tmux client, not its worker.
attach_stub="$TMP/attach-viewer.sh"
cat >"$attach_stub" <<'EOF'
#!/usr/bin/env bash
exec tmux -S "$FAMILIAR_PRESENCE_SOCKET" attach-session -t presence
EOF
chmod 700 "$attach_stub"
viewer_command="env FAMILIAR_PRESENCE_STATE_DIR='$state' FAMILIAR_PRESENCE_SOCKET='$socket' FAMILIAR_PRESENCE_COMMAND='exec $BASH_BIN $FAKE' WORKER_PIDS='$pids' FAMILIAR_VIEWER_BIN='$attach_stub' bash '$PRESENCE' viewer"
for _ in 1 2; do
  set +e
  timeout 0.5 script -qec "$viewer_command" /dev/null >/dev/null 2>&1
  set -e
  kill -0 "$pid" || fail "viewer cleanup killed worker"
done
[ "$(tail -1 "$pids")" = "$pid" ] || fail "viewer detach replaced worker"
[ -z "$(tmux -S "$socket" list-clients -F '#{client_name}' 2>/dev/null)" ] || fail "attach client survived viewer cleanup"
[ "$(tmux -S "$socket" list-sessions -F '#{session_name}')" = presence ] || fail "viewer attach created outer session"
ok "viewer attach/detach reaps only clients and preserves exact worker pid"

# Concurrent viewer processes independently consume the same resident session.
concurrent_stub="$TMP/concurrent-viewer.sh"; concurrent_log="$TMP/concurrent.log"
cat >"$concurrent_stub" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$$" >> "$VIEWER_LOG"
sleep .2
EOF
chmod 700 "$concurrent_stub"
for _ in 1 2 3 4; do VIEWER_LOG="$concurrent_log" FAMILIAR_VIEWER_BIN="$concurrent_stub" runp viewer & done
wait
[ "$(sort -u "$concurrent_log" | wc -l)" -eq 4 ] || fail "concurrent viewers interfered"
[ "$(sort -u "$pids" | wc -l)" -eq 1 ] || fail "concurrent viewers duplicated worker"
[ "$(tmux -S "$socket" list-sessions -F '#{session_name}')" = presence ] || fail "concurrent viewers created outer session"
ok "concurrent viewer processes do not interfere or duplicate Presence"

# A worker exit removes the sole pane/session; ensure recreates the session.
kill -TERM "$pid"
for _ in $(seq 1 50); do
  ! tmux -S "$socket" has-session -t presence 2>/dev/null && break
  sleep .05
done
if tmux -S "$socket" has-session -t presence 2>/dev/null; then
  fail "dead worker left a lingering pane/session"
fi
runp ensure >/dev/null
newpid=$pid
for _ in $(seq 1 50); do newpid=$(tail -1 "$pids"); [ "$newpid" != "$pid" ] && break; sleep .05; done
if [ "$newpid" = "$pid" ] || ! kill -0 "$newpid"; then
  fail "missing session not recovered after worker exit"
fi
ok "worker death removes the pane and ensure recreates the session"

# A missing owned session is recreated without treating other sessions as ours.
tmux -S "$socket" new-session -d -s diagnostic 'read -r -t 30 _ || true'
tmux -S "$socket" kill-session -t presence
runp ensure >/dev/null
kill -0 "$(tail -1 "$pids")" || fail "missing session not recovered"
tmux -S "$socket" has-session -t diagnostic || fail "diagnostic session was disturbed"
[ -z "$(tmux -S "$socket" list-sessions -F '#{session_name}' | grep -Fx viewer || true)" ] || fail "recovery created viewer session"
ok "missing inner session is recovered without disturbing unrelated sessions"

# Concurrent lifecycle ensures remain serialized.
current_pid=$(tail -1 "$pids")
for _ in 1 2 3 4 5 6; do runp ensure >/dev/null & done
wait
[ "$(tail -1 "$pids")" = "$current_pid" ] || fail "concurrent ensure replaced worker"
kill -0 "$current_pid" || fail "concurrent ensure killed worker"
ok "concurrent ensure is serialized"

# Stop is socket-scoped.
other="$TMP/other.sock"
tmux -S "$other" -f /dev/null new-session -d -s unrelated 'sleep 30'
runp stop
tmux -S "$other" has-session -t unrelated
[ ! -S "$socket" ] || fail "owned socket survived stop"
tmux -S "$other" kill-server
ok "stop kills only the owned server"

# State and socket path safety remains strict.
unsafe="$TMP/unsafe"; mkdir "$unsafe.real"; ln -s "$unsafe.real" "$unsafe"
if FAMILIAR_PRESENCE_STATE_DIR="$unsafe" FAMILIAR_PRESENCE_SOCKET="$unsafe/tmux.sock" bash "$PRESENCE" ensure >/dev/null 2>&1; then fail "symlink state accepted"; fi
safe="$TMP/safe"; mkdir "$safe"; ln -s "$TMP/not-a-socket" "$safe/tmux.sock"
if FAMILIAR_PRESENCE_STATE_DIR="$safe" FAMILIAR_PRESENCE_SOCKET="$safe/tmux.sock" bash "$PRESENCE" ensure >/dev/null 2>&1; then fail "symlink socket accepted"; fi
ok "symlink state and socket paths are rejected"

# Chunk 6 browser contracts remain fixed.
if [ -z "${SKIP_BROWSER_CONTRACT:-}" ]; then
  grep -q 'FAMILIAR_VIEWER_BIN || "familiar-viewer"' "$HERE/../gateway/src/attach.ts" \
    || fail "browser default is not native familiar-viewer"
  grep -q 'FAMILIAR_ATTACH_CMD' "$HERE/../gateway/src/pty.ts" || fail "browser test override missing"
  grep -q 'spawnSync(controller, \["ensure"\]' "$HERE/../gateway/src/pty.ts" \
    || fail "browser gateway does not ensure Presence"
  ok "browser attach command points at native Viewer"
fi

printf '1..%d\n' "$pass"
