#!/usr/bin/env bash
# Temporary tmux-backed Familiar Presence Runtime adapter.
set -euo pipefail

SELF=$(realpath "$0")
HERE=$(CDPATH='' cd -- "$(dirname -- "$SELF")" && pwd -P)
REPO=${FAMILIAR_REPO:-$(CDPATH='' cd -- "$HERE/../.." && pwd -P)}
STATE=${FAMILIAR_PRESENCE_STATE_DIR:-$REPO/state/presence}
SOCKET=${FAMILIAR_PRESENCE_SOCKET:-$STATE/tmux.sock}
SESSION=${FAMILIAR_PRESENCE_SESSION:-presence}
TARGET="$SESSION:0.0"
RUNTIME_CONFIG="$STATE/tmux.conf"
CONFIG_SOURCE=${FAMILIAR_PRESENCE_CONFIG:-$HERE/tmux.conf}
LOCK="$STATE/ensure.lock"
BASH_EXE=${FAMILIAR_PRESENCE_BASH:-$(command -v bash)}
export FAMILIAR_PRESENCE_BASH="$BASH_EXE"

fail() { printf 'familiar presence: %s\n' "$*" >&2; return 1; }

check_path() {
  case "$STATE" in /*) ;; *) fail "state directory must be absolute: $STATE" ;; esac
  case "$SOCKET" in /*) ;; *) fail "socket path must be absolute: $SOCKET" ;; esac
  case "$SOCKET" in "$STATE"/*) ;; *) fail "socket must be beneath private state directory $STATE" ;; esac
  [ ! -L "$STATE" ] || fail "refusing symlink state directory: $STATE"
  [ ! -L "$SOCKET" ] || fail "refusing symlink socket: $SOCKET"
  [ ! -L "$RUNTIME_CONFIG" ] || fail "refusing symlink config: $RUNTIME_CONFIG"
  [ ! -L "$LOCK" ] || fail "refusing symlink lock: $LOCK"
  [ ! -e "$LOCK" ] || [ -f "$LOCK" ] || fail "lock path is not a regular file: $LOCK"
}

prepare() {
  check_path
  umask 077
  install -d -m 700 "$STATE"
  chmod 700 "$STATE"
  if [ -e "$SOCKET" ] && [ ! -S "$SOCKET" ]; then
    fail "socket path exists and is not a socket: $SOCKET"
  fi
  : > "$LOCK"
  chmod 600 "$LOCK"
}

tmux_owned() { tmux -S "$SOCKET" "$@"; }
server_alive() { tmux_owned show-options -g status >/dev/null 2>&1; }
server_up() { tmux_owned has-session -t "$SESSION" >/dev/null 2>&1; }

# Refresh variables consumed by a respawn. tmux's server may outlive the shell
# which originally created it, so reload must not retain old Familiar config.
refresh_environment() {
  local name
  while IFS='=' read -r name _; do
    case "$name" in
      FAMILIAR_*|PI_*|LLAMA_*|ANTHROPIC_*|OPENAI_*)
        tmux_owned set-environment -g "$name" "${!name}" >/dev/null ;;
    esac
  done < <(env)
}

worker_command() {
  if [ -n "${FAMILIAR_PRESENCE_COMMAND:-}" ]; then
    exec "$BASH_EXE" -lc "$FAMILIAR_PRESENCE_COMMAND"
  fi
  local request=${FAMILIAR_RELOAD_REQUEST_PATH:-$REPO/state/run/reload-request}
  local complete=${FAMILIAR_RELOAD_COMPLETE_PATH:-$REPO/state/run/reload-complete}
  while :; do
    "$REPO/familiar.sh" pi || true
    if [ -f "$request" ]; then
      mkdir -p "$(dirname "$complete")"
      mv -f "$request" "$complete"
      # Re-enter through the current script/config/dev shell. familiar.sh pi
      # always launches pi with --continue, preserving session continuity.
      unset FAMILIAR_SHELL FAMILIAR_INTERACTIVE_SHELL
      continue
    fi
    sleep 1
  done
}

start_session() {
  # -S selects only our socket. -f is supplied on server creation, preventing
  # both /etc/tmux.conf and ~/.tmux.conf from being loaded.
  tmux -S "$SOCKET" -f "$RUNTIME_CONFIG" new-session -d -s "$SESSION" -n presence \
    "exec $(printf %q "$BASH_EXE") $(printf %q "$SELF") run-worker"
}

ensure_locked() {
  install -m 600 "$CONFIG_SOURCE" "$RUNTIME_CONFIG"
  # Avoid tmux's compiled /bin/sh default (absent in pure Nix builds) while
  # retaining the explicit static policy above. Bash paths cannot contain a
  # quote in supported deployments.
  case "$BASH_EXE" in *\"*) fail "unsupported quote in bash path" ;; esac
  printf 'set-option -g default-shell "%s"\n' "$BASH_EXE" >> "$RUNTIME_CONFIG"
  if ! server_up; then
    if server_alive; then
      # The owned server survived but its Presence session did not. Keep any
      # diagnostic sessions and recreate only ours.
      start_session
    else
      # A refused connection means no owner exists. Remove only a stale socket;
      # regular files and symlinks were rejected above.
      [ ! -S "$SOCKET" ] || rm -f -- "$SOCKET"
      if ! start_session; then
        fail "could not start private tmux server at $SOCKET"
      fi
    fi
  fi
  refresh_environment
  local dead
  dead=$(tmux_owned display-message -p -t "$TARGET" '#{pane_dead}' 2>/dev/null) || {
    tmux_owned kill-session -t "$SESSION" >/dev/null 2>&1 || true
    start_session
    refresh_environment
    dead=$(tmux_owned display-message -p -t "$TARGET" '#{pane_dead}')
  }
  if [ "$dead" = 1 ]; then
    tmux_owned respawn-pane -k -t "$TARGET" "exec $(printf %q "$BASH_EXE") $(printf %q "$SELF") run-worker"
  fi
  local tries=0 pid
  while [ "$tries" -lt 50 ]; do
    pid=$(tmux_owned display-message -p -t "$TARGET" '#{pane_pid}:#{pane_dead}' 2>/dev/null || true)
    case "$pid" in *:0) printf '%s\n' "${pid%:*}"; return 0 ;; esac
    tries=$((tries + 1)); sleep 0.1
  done
  local tail
  printf 'familiar presence: pane command=%s shell=%s\n' \
    "$(tmux_owned display-message -p -t "$TARGET" '#{pane_start_command}' 2>/dev/null || true)" \
    "$(tmux_owned show-options -gv default-shell 2>/dev/null || true)" >&2
  tail=$(tmux_owned capture-pane -p -t "$TARGET" -S -20 2>/dev/null | tail -20 || true)
  [ -z "$tail" ] || printf 'familiar presence: worker pane output:\n%s\n' "$tail" >&2
  fail "worker did not become live within 5s (socket $SOCKET)"
}

ensure() {
  prepare
  command -v tmux >/dev/null || fail "tmux is required"
  command -v flock >/dev/null || fail "flock is required"
  # -o closes flock's descriptor before running the child; otherwise tmux and
  # the long-lived worker inherit it and hold the lock forever.
  flock -o -w 10 "$LOCK" "$BASH_EXE" "$SELF" ensure-locked \
    || fail "ensure failed or timed out waiting for $LOCK"
}

status() {
  check_path
  if server_up && [ "$(tmux_owned display-message -p -t "$TARGET" '#{pane_dead}' 2>/dev/null || echo 1)" = 0 ]; then
    [ "${2:-}" = --quiet ] || tmux_owned display-message -p -t "$TARGET" 'running pid=#{pane_pid} socket='"$SOCKET"
    return 0
  fi
  [ "${2:-}" = --quiet ] || printf 'stopped socket=%s\n' "$SOCKET"
  return 1
}

attach() {
  ensure >/dev/null
  exec tmux -S "$SOCKET" attach-session -t "$SESSION"
}

stop() {
  check_path
  if [ -S "$SOCKET" ]; then tmux_owned kill-server >/dev/null 2>&1 || true; fi
  local tries=0
  while tmux_owned list-sessions >/dev/null 2>&1 && [ "$tries" -lt 50 ]; do
    tries=$((tries + 1)); sleep 0.05
  done
  if tmux_owned list-sessions >/dev/null 2>&1; then
    fail "private tmux server did not stop within 2.5s: $SOCKET"
  fi
  # tmux may leave the now-unbound socket inode behind.
  [ ! -S "$SOCKET" ] || rm -f -- "$SOCKET"
}

case ${1:-} in
  ensure|start) ensure ;;
  attach) attach ;;
  status) status "$@" ;;
  stop) stop ;;
  ensure-locked) ensure_locked ;; # internal child entered only through flock
  run-worker) worker_command ;;
  *) fail "usage: $0 {ensure|start|attach|status [--quiet]|stop}" ;;
esac
