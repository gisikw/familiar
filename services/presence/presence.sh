#!/usr/bin/env bash
# Temporary tmux-backed Familiar Presence Runtime adapter.
set -euo pipefail

SELF=$(realpath "$0")
HERE=$(CDPATH='' cd -- "$(dirname -- "$SELF")" && pwd -P)
REPO=${FAMILIAR_REPO:-$(CDPATH='' cd -- "$HERE/../.." && pwd -P)}
STATE=${FAMILIAR_PRESENCE_STATE_DIR:-$REPO/state/presence}
SOCKET=${FAMILIAR_PRESENCE_SOCKET:-$STATE/tmux.sock}
SESSION=${FAMILIAR_PRESENCE_SESSION:-presence}
VIEWER=${FAMILIAR_VIEWER_SESSION:-viewer}
TARGET="$SESSION:0.0"
VIEWER_SIDEBAR="$VIEWER:0.0"
VIEWER_MAIN="$VIEWER:0.1"
SIDEBAR=${FAMILIAR_SIDEBAR_SCRIPT:-$HERE/sidebar.sh}
AGENTS_STATE=${FAMILIAR_AGENTS_SUPERVISOR_STATE:-$REPO/state/agents-supervisor}
AGENTS_SOCKET=${FAMILIAR_AGENTS_SOCKET:-$AGENTS_STATE/tmux.sock}
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
viewer_up() { tmux_owned has-session -t "$VIEWER" >/dev/null 2>&1; }

# Refresh variables consumed by a respawn. tmux's server may outlive the shell
# which originally created it, so a recovered worker must not retain old config.
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
  while :; do
    # familiar.sh always launches pi with --continue, so an unexpected exit
    # preserves session continuity when this worker relaunches it.
    "$REPO/familiar.sh" pi || true
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
  # The private server intentionally survives deployments, so apply the newly
  # installed owned config even when this invocation did not create it.
  tmux_owned source-file "$RUNTIME_CONFIG"
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

sidebar_command() {
  printf 'exec %q %q run-sidebar' "$BASH_EXE" "$SELF"
}

nested_command() {
  # Clearing TMUX permits this outer pane to host a client from any tmux server.
  printf 'TMUX= exec tmux -S %q attach-session -t %q' "$SOCKET" "$SESSION"
}

agent_command() {
  local session=$1
  # Worker views are deliberately read-only: sidebar navigation must not route
  # browser keystrokes into a delegated process.
  printf 'TMUX= exec tmux -S %q attach-session -r -t %q' "$AGENTS_SOCKET" "$session"
}

show_presence() {
  viewer_up || fail "viewer is not running"
  local cmd; cmd=$(nested_command)
  tmux_owned respawn-pane -k -t "$VIEWER_MAIN" "$cmd"
  tmux_owned set-option -p -t "$VIEWER_MAIN" @familiar_target presence
  tmux_owned select-pane -t "$VIEWER_MAIN"
}

show_agent() {
  local id=${1:-} safe session cmd dead
  [ -n "$id" ] || fail "agent job id is required"
  safe=$(printf '%s' "$id" | sed 's/[^A-Za-z0-9_-]/-/g')
  session="worker-$safe"
  if [ ! -S "$AGENTS_SOCKET" ] || ! tmux -S "$AGENTS_SOCKET" has-session -t "$session" 2>/dev/null; then
    fail "agent session is no longer available: $id"
  fi
  dead=$(tmux -S "$AGENTS_SOCKET" display-message -p -t "$session:0.0" '#{pane_dead}' 2>/dev/null) || dead=1
  [ "$dead" = 0 ] || fail "agent session has exited: $id"
  cmd=$(agent_command "$session")
  tmux_owned respawn-pane -k -t "$VIEWER_MAIN" "$cmd"
  tmux_owned set-option -p -t "$VIEWER_MAIN" @familiar_target "agent:$id"
  tmux_owned select-pane -t "$VIEWER_MAIN"
}

configure_viewer() {
  local sidebar_cmd border border_muted border_env
  sidebar_cmd=$(sidebar_command)
  if ! border_env=$("$BASH_EXE" "$REPO/scripts/familiar-theme.sh" pane-borders); then
    fail "could not resolve Viewer pane border colors"
  fi
  eval "$border_env"
  # All chrome policy is session-local: Presence retains its normal C-b prefix
  # and mouse behavior while clients attached to Viewer cannot address it.
  tmux_owned set-option -t "$VIEWER" prefix None
  tmux_owned set-option -t "$VIEWER" status off
  # Mouse mode lets applications opt in per pane. The sidebar requests SGR
  # clicks; nested tmux continues to receive mouse reports in the main pane.
  tmux_owned set-option -t "$VIEWER" mouse on
  tmux_owned set-option -t "$VIEWER" pane-border-status off
  tmux_owned set-option -t "$VIEWER" pane-border-style "fg=$border_muted"
  tmux_owned set-option -t "$VIEWER" pane-active-border-style "fg=$border"
  tmux_owned set-window-option -t "$VIEWER:0" allow-passthrough all
  tmux_owned set-hook -t "$VIEWER" after-split-window "resize-pane -t '$VIEWER_SIDEBAR' -x 28"
  tmux_owned set-hook -t "$VIEWER" client-resized "resize-pane -t '$VIEWER_SIDEBAR' -x 28"
  tmux_owned set-hook -t "$VIEWER" window-resized "resize-pane -t '$VIEWER_SIDEBAR' -x 28"
  tmux_owned set-hook -t "$VIEWER" client-attached "select-pane -t '$VIEWER_MAIN'"
  # Hook commands inherit the dead pane as their target; omitting -t matters
  # because tmux does not expand #{pane_id} in a nested respawn-pane argument.
  tmux_owned set-hook -t "$VIEWER" pane-died \
    "if-shell -F '#{==:#{pane_index},0}' 'respawn-pane -k \"$sidebar_cmd\"'"
  tmux_owned resize-pane -t "$VIEWER_SIDEBAR" -x 28
  tmux_owned select-pane -t "$VIEWER_MAIN"
  tmux_owned select-pane -e -t "$VIEWER_SIDEBAR"
  if [ -z "$(tmux_owned show-option -pqv -t "$VIEWER_MAIN" @familiar_target 2>/dev/null || true)" ]; then
    tmux_owned set-option -p -t "$VIEWER_MAIN" @familiar_target presence
  fi
}

ensure_viewer_locked() {
  local sidebar_cmd main_cmd panes dead
  sidebar_cmd=$(sidebar_command)
  main_cmd=$(nested_command)
  if ! viewer_up; then
    tmux_owned new-session -d -s "$VIEWER" -n viewer "$sidebar_cmd"
    tmux_owned split-window -d -h -t "$VIEWER:0" "$main_cmd"
  fi
  panes=$(tmux_owned list-panes -t "$VIEWER:0" | wc -l)
  [ "$panes" -eq 2 ] || fail "viewer session must contain exactly two panes (found $panes)"
  configure_viewer
  dead=$(tmux_owned display-message -p -t "$VIEWER_SIDEBAR" '#{pane_dead}')
  [ "$dead" = 0 ] || tmux_owned respawn-pane -k -t "$VIEWER_SIDEBAR" "$sidebar_cmd"
  dead=$(tmux_owned display-message -p -t "$VIEWER_MAIN" '#{pane_dead}')
  [ "$dead" = 0 ] || tmux_owned respawn-pane -k -t "$VIEWER_MAIN" "$main_cmd"
}

ensure_viewer() {
  ensure >/dev/null
  flock -o -w 10 "$LOCK" "$BASH_EXE" "$SELF" ensure-viewer-locked \
    || fail "viewer ensure failed or timed out waiting for $LOCK"
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

attach_presence() {
  ensure >/dev/null
  exec tmux -S "$SOCKET" attach-session -t "$SESSION"
}

attach_viewer() {
  ensure_viewer >/dev/null
  exec tmux -S "$SOCKET" attach-session -t "$VIEWER"
}

run_sidebar() {
  # Keep supervising the renderer in addition to the pane-died hook: a renderer
  # error should never turn the fixed chrome pane into a dead pane.
  #
  # The pane inherits the tmux server's environment, which in production comes
  # from the supervisor and carries no jq/curl/librsvg. The repo's pi dev shell
  # already packages all three, so enter it when nix is available; fall back to
  # a bare run (mark text fallback, no registry) rather than fail the pane.
  while :; do
    if command -v nix >/dev/null 2>&1; then
      nix develop "$REPO#pi" --command "$BASH_EXE" "$SIDEBAR" || "$BASH_EXE" "$SIDEBAR" || true
    else
      "$BASH_EXE" "$SIDEBAR" || true
    fi
    sleep 1
  done
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
  viewer|attach) attach_viewer ;;
  attach-presence) attach_presence ;;
  status) status "$@" ;;
  stop) stop ;;
  ensure-viewer) ensure_viewer ;;
  ensure-locked) ensure_locked ;; # internal child entered only through flock
  ensure-viewer-locked) ensure_viewer_locked ;; # internal, under the same lock
  run-worker) worker_command ;;
  run-sidebar) run_sidebar ;;
  show-presence) show_presence ;;
  show-agent) show_agent "${2:-}" ;;
  *) fail "usage: $0 {ensure|start|ensure-viewer|viewer|attach|attach-presence|show-presence|show-agent ID|status [--quiet]|stop}" ;;
esac
