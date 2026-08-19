#!/usr/bin/env bash
# Subagent watcher — the return channel Herdr doesn't have.
#
# Herdr can block until an agent settles (`agent prompt --wait`), but it cannot
# push that transition anywhere. So we park the blocking call in a detached
# process instead of in the familiar's turn: waiting costs a process, not
# inference. Every lifecycle transition is appended to events.ndjson, which the
# subagent extension tails and turns into settlements.
#
# Topology (workspace, worktree, pane) belongs to the extension: those calls are
# fast and synchronous, and dispatch must return immediately. This script only
# does the slow parts — starting the agent and blocking on it.
#
# Usage: watcher.sh <job-dir> <phase> [arg]
#   launch        start the agent in the prepared pane, deliver prompt, wait
#   resume        same, against the same pi session id, with a resume nudge
#   attach        agent is already live; just wait
#   respond <n>   deliver prompt-<n>.txt to a live agent, wait
#
# Invariant: this script never exits without appending a terminal event, so a
# job can never sit "running" forever because a step failed quietly.

set -uo pipefail

JOB="${1:?job dir}"
PHASE="${2:?phase}"
ARG="${3:-}"

cd "$JOB" || exit 1

emit() { # emit <status> [reason]
  jq -cn --arg s "$1" --arg r "${2:-}" --arg p "$PHASE" \
    '{at: (now | todate), phase: $p, status: $s} + (if $r == "" then {} else {reason: $r} end)' \
    >>events.ndjson
}

log() { printf '%s [%s] %s\n' "$(date -Is)" "$PHASE" "$*" >>watcher.log; }

NAME="$(jq -r .id command.json)"
KIND="$(jq -r .kind command.json)"
TIMEOUT_S="$(jq -r .timeout command.json)"
WAIT_MS=$((TIMEOUT_S * 1000))
PANE="$(cat pane 2>/dev/null)"

trap 'emit error "watcher terminated"' TERM INT

# --- start the agent in the pane the extension prepared ----------------------
start_agent() {
  local out rc
  local -a args=()
  mapfile -t args < <(jq -r '.agent_args[]? // empty' command.json)

  if [[ -z "$PANE" ]]; then
    emit error "no pane recorded for job"
    return 1
  fi

  out="$(herdr agent start "$NAME" --kind "$KIND" --pane "$PANE" --timeout 120000 -- "${args[@]}" 2>&1)"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    log "agent start failed: $out"
    emit error "agent start failed: $(printf '%s' "$out" | tail -c 300)"
    return 1
  fi
  log "agent started in $PANE"
  return 0
}

# --- deliver a prompt and block until the agent settles ----------------------
deliver() { # deliver <prompt-file>
  local out rc status code
  out="$(herdr agent prompt "$NAME" "$(cat "$1")" --wait --timeout "$WAIT_MS" 2>&1)"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    # agent_blocked / agent_prompt_stalled / timeout all land here.
    code="$(printf '%s' "$out" | jq -r '.error.code // empty' 2>/dev/null)"
    log "prompt failed (${code:-unknown}): $out"
    emit error "${code:-prompt failed}: $(printf '%s' "$out" | tail -c 300)"
    return 1
  fi
  status="$(printf '%s' "$out" | jq -r '.result.agent.agent_status // "unknown"')"
  log "settled: $status"
  emit "$status"
  return 0
}

# --- wait on an already-working agent ----------------------------------------
observe() {
  local out rc status
  out="$(herdr agent wait "$NAME" --timeout "$WAIT_MS" 2>&1)"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    log "wait failed: $out"
    emit error "wait failed: $(printf '%s' "$out" | tail -c 300)"
    return 1
  fi
  status="$(printf '%s' "$out" | jq -r '.result.agent.agent_status // "unknown"')"
  log "settled: $status"
  emit "$status"
  return 0
}

case "$PHASE" in
launch)
  start_agent || exit 1
  deliver prompt.txt
  ;;
resume)
  start_agent || exit 1
  deliver resume-prompt.txt
  ;;
attach)
  observe
  ;;
respond)
  deliver "prompt-${ARG:?pass}.txt"
  ;;
*)
  emit error "unknown phase: $PHASE"
  exit 2
  ;;
esac

trap - TERM INT
