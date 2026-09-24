#!/usr/bin/env bash
# Tmux-backed TTY adapter. systemd is the sole production caller of `start`.
set -euo pipefail

SELF=$(realpath "$0")
HERE=$(CDPATH='' cd -- "$(dirname -- "$SELF")" && pwd -P)
REPO=${FAMILIAR_REPO:-$(CDPATH='' cd -- "$HERE/../.." && pwd -P)}
STATE=${FAMILIAR_PRESENCE_STATE_DIR:-$REPO/state/presence}
SOCKET=${FAMILIAR_PRESENCE_SOCKET:-$STATE/tmux.sock}
SESSION=${FAMILIAR_PRESENCE_SESSION:-presence}
PRESENCE_CWD=${FAMILIAR_PRESENCE_CWD:-$PWD}
TARGET="$SESSION:0.0"
RUNTIME_CONFIG="$STATE/tmux.conf"
THEME_CONFIG=${FAMILIAR_TMUX_THEME_CONFIG:-$STATE/tmux-theme.conf}
CONFIG_SOURCE=${FAMILIAR_PRESENCE_CONFIG:-$HERE/tmux.conf}
PID_FILE=${FAMILIAR_PRESENCE_PID_FILE:-$STATE/pi.pid}
BASH_EXE=${FAMILIAR_PRESENCE_BASH:-$(command -v bash)}
INTERACTIVE_BASH=${FAMILIAR_INTERACTIVE_SHELL:-$BASH_EXE}
export FAMILIAR_PRESENCE_BASH="$BASH_EXE"
export FAMILIAR_PRESENCE_STATE_DIR="$STATE"
export FAMILIAR_PRESENCE_SOCKET="$SOCKET"

fail() { printf 'familiar presence: %s\n' "$*" >&2; return 1; }

check_path() {
  case "$STATE" in /*) ;; *) fail "state directory must be absolute: $STATE" ;; esac
  case "$SOCKET" in /*) ;; *) fail "socket path must be absolute: $SOCKET" ;; esac
  case "$SOCKET" in "$STATE"/*) ;; *) fail "socket must be beneath private state directory $STATE" ;; esac
  case "$PID_FILE" in "$STATE"/*) ;; *) fail "pid file must be beneath private state directory $STATE" ;; esac
  [ ! -L "$STATE" ] || fail "refusing symlink state directory: $STATE"
  for path in "$SOCKET" "$RUNTIME_CONFIG" "$THEME_CONFIG" "$PID_FILE"; do
    [ ! -L "$path" ] || fail "refusing symlink path: $path"
  done
}

tmux_owned() { tmux -S "$SOCKET" "$@"; }
server_alive() { tmux_owned show-options -g status >/dev/null 2>&1; }
server_up() { tmux_owned has-session -t "$SESSION" >/dev/null 2>&1; }

prepare() {
  check_path
  command -v tmux >/dev/null || fail "tmux is required"
  umask 077
  install -d -m 700 "$STATE"
  install -m 600 "$CONFIG_SOURCE" "$RUNTIME_CONFIG"
  if [ -e "$SOCKET" ] && [ ! -S "$SOCKET" ]; then
    fail "socket path exists and is not a socket: $SOCKET"
  fi
  if bash "$REPO/scripts/familiar-theme.sh" tmux > "$THEME_CONFIG" 2>/dev/null; then
    chmod 600 "$THEME_CONFIG"
    cat "$THEME_CONFIG" >> "$RUNTIME_CONFIG"
  else
    rm -f "$THEME_CONFIG"
    printf 'familiar presence: theme styling skipped\n' >&2
  fi
  case "$BASH_EXE$INTERACTIVE_BASH" in *\"*) fail "unsupported quote in bash path" ;; esac
  printf 'set-option -g default-shell "%s"\n' "$INTERACTIVE_BASH" >> "$RUNTIME_CONFIG"
}

worker_command() {
  if [ -n "${FAMILIAR_PRESENCE_COMMAND:-}" ]; then
    exec "$BASH_EXE" -lc "$FAMILIAR_PRESENCE_COMMAND"
  fi
  exec "$REPO/familiar.sh" pi
}

start() {
  prepare
  server_up && fail "session is already running at $SOCKET"
  if ! server_alive && [ -S "$SOCKET" ]; then rm -f -- "$SOCKET"; fi
  tmux -S "$SOCKET" -f "$RUNTIME_CONFIG" new-session -d -c "$PRESENCE_CWD" \
    -s "$SESSION" -n presence "exec $(printf %q "$BASH_EXE") $(printf %q "$SELF") run-worker"
  tmux_owned source-file "$RUNTIME_CONFIG"
  local pid
  pid=$(tmux_owned display-message -p -t "$TARGET" '#{pid}')
  case "$pid" in ''|*[!0-9]*) fail "tmux did not report a server pid" ;; esac
  printf '%s\n' "$pid" > "$PID_FILE.tmp"
  chmod 600 "$PID_FILE.tmp"
  mv -f "$PID_FILE.tmp" "$PID_FILE"
}

status() {
  check_path
  if server_up && [ "$(tmux_owned display-message -p -t "$TARGET" '#{pane_dead}' 2>/dev/null || echo 1)" = 0 ]; then
    [ "${1:-}" = --quiet ] || tmux_owned display-message -p -t "$TARGET" 'running pid=#{pane_pid} socket='"$SOCKET"
    return 0
  fi
  [ "${1:-}" = --quiet ] || printf 'stopped socket=%s\n' "$SOCKET"
  return 1
}

require_running() {
  status --quiet || fail "Pi is not running; start familiar-pi@<instance>.service"
}

viewer() {
  require_running
  local executable=${FAMILIAR_VIEWER_BIN:-familiar-viewer}
  command -v "$executable" >/dev/null 2>&1 \
    || fail "native viewer not found: set FAMILIAR_VIEWER_BIN or install familiar-viewer on PATH"
  exec "$executable"
}

attach_presence() {
  require_running
  exec tmux -S "$SOCKET" attach-session -t "$SESSION"
}

stop() {
  check_path
  if [ -S "$SOCKET" ]; then tmux_owned kill-server >/dev/null 2>&1 || true; fi
  local tries=0
  while server_alive && [ "$tries" -lt 50 ]; do tries=$((tries + 1)); sleep .05; done
  server_alive && fail "private tmux server did not stop: $SOCKET"
  rm -f -- "$SOCKET" "$PID_FILE" "$PID_FILE.tmp"
}

case ${1:-} in
  start) start ;;
  viewer|attach) viewer ;;
  attach-presence) attach_presence ;;
  status) shift; status "$@" ;;
  stop) stop ;;
  run-worker) worker_command ;; # internal tmux pane command
  ensure) fail "ensure was removed; systemd owns Pi lifecycle" ;;
  *) fail "usage: $0 {start|viewer|attach|attach-presence|status [--quiet]|stop}" ;;
esac
