#!/usr/bin/env bash
# Adapter used only by familiar-pi@ fork units; systemd supplies the roots.
set -euo pipefail
: "${FAMILIAR_FORK_ID:?}" "${FAMILIAR_STATE_DIR:?}" "${FAMILIAR_REPO:?}"
root="$FAMILIAR_STATE_DIR/forks/$FAMILIAR_FORK_ID"
meta="$root/fork.json"
[ -f "$meta" ] || { echo "missing fork metadata: $meta" >&2; exit 1; }
export PI_CODING_AGENT_DIR="$root/pi"
export FAMILIAR_PI_FORK=1
export FAMILIAR_FORK_SESSION_FILE="$(jq -er .sessionFile "$meta")"
# Keep trailing newlines: command substitution would otherwise change the task
# between fork metadata and Pi's persisted initial user message.
task="$(jq -er '.task + "\u0001"' "$meta")"
task="${task%$'\001'}"
export FAMILIAR_FORK_INITIAL_MESSAGE="$task"
# The task is delivered once. A restarted fork resumes its own session; if any
# message already follows the fork marker, the task was delivered, so re-sending
# it would make the fork redo its work.
if jq -se '(map(.customType == "familiar.fork.v1") | rindex(true)) as $m | $m != null and any(.[$m + 1:][]; .type == "message")' "$FAMILIAR_FORK_SESSION_FILE" >/dev/null 2>&1; then
  unset FAMILIAR_FORK_INITIAL_MESSAGE
fi
export FAMILIAR_PRESENCE_STATE_DIR="$root/presence"
export FAMILIAR_PRESENCE_SOCKET="$root/presence/tmux.sock"
export FAMILIAR_PRESENCE_PID_FILE="$root/presence/pi.pid"
export FAMILIAR_PRESENCE_CWD="$(jq -er .cwd "$meta")"
export FAMILIAR_LOG_PATH="$root/log.jsonl"
export FAMILIAR_SUBCONSCIOUS_DIR="$root/subconscious"
# Settlement must never share the primary cursor. Plugins may honor this root.
export FAMILIAR_AGENTS_STATE_DIR="$root/golem-settlement"
exec "$FAMILIAR_REPO/services/presence/presence.sh" "$1"
