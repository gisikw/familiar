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
  jq -cn --arg s "$1" --arg r "${2:-}" --arg p "$PHASE" --argjson n "$PASS" \
    '{at: (now | todate), pass: $n, phase: $p, status: $s} + (if $r == "" then {} else {reason: $r} end)' \
    >>events.ndjson
}

log() { printf '%s [%s] %s\n' "$(date -Is)" "$PHASE" "$*" >>watcher.log; }

NAME="$(jq -r .id command.json)"
KIND="$(jq -r .kind command.json)"
TIMEOUT_S="$(jq -r .timeout command.json)"
WAIT_MS=$((TIMEOUT_S * 1000))
PANE="$(cat pane 2>/dev/null)"
# Events are pass-scoped: the poller must never act on a previous pass's
# terminal event. `respond` passes its pass number in; every other phase
# operates on whatever pass is current when it starts.
PASS="${ARG:-$(cat pass 2>/dev/null || echo 1)}"

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
# A blocked agent cannot be prompted: Herdr rejects submission with
# agent_blocked before sending any input. Answering one means typing into its
# dialog, then waiting for the turn that answer produces.
deliver() { # deliver <prompt-file>
  local out rc status code
  status="$(herdr agent get "$NAME" 2>/dev/null | jq -r '.result.agent.agent_status // empty')"
  if [[ "$status" == "blocked" ]]; then
    log "agent is blocked; answering through send-keys"
    answer_blocked "$1"
    return $?
  fi

  out="$(herdr agent prompt "$NAME" "$(cat "$1")" --wait --timeout "$WAIT_MS" 2>&1)"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    code="$(printf '%s' "$out" | jq -r '.error.code // empty' 2>/dev/null)"
    # A cold-starting child can miss Herdr's 5s lifecycle-change window even
    # though it is perfectly healthy; re-wait rather than declaring a crash.
    if [[ "$code" == "agent_prompt_stalled" ]]; then
      log "prompt stalled; agent healthy, waiting for settle"
      observe
      return $?
    fi
    log "prompt failed (${code:-unknown}): $out"
    emit error "${code:-prompt failed}: $(printf '%s' "$out" | tail -c 300)"
    return 1
  fi
  status="$(printf '%s' "$out" | jq -r '.result.agent.agent_status // "unknown"')"
  log "settled: $status"
  emit "$status"
  return 0
}

# --- answer a blocked agent --------------------------------------------------
# `agent prompt` is refused while a dialog is up, so type the answer into the
# pane instead: literal text, then Enter to submit. Uses the pane surface
# because the agent surface only accepts key names, not arbitrary text.
answer_blocked() { # answer_blocked <prompt-file>
  local out rc text
  text="$(cat "$1")"
  if [[ -z "$PANE" ]]; then
    emit error "no pane recorded; cannot answer blocked agent"
    return 1
  fi
  out="$(herdr pane send-text "$PANE" "$text" 2>&1)"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    log "send-text failed: $out"
    emit error "could not answer blocked agent: $(printf '%s' "$out" | tail -c 300)"
    return 1
  fi
  out="$(herdr pane send-keys "$PANE" enter 2>&1)"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    log "send-keys enter failed: $out"
    emit error "could not submit answer to blocked agent: $(printf '%s' "$out" | tail -c 300)"
    return 1
  fi
  observe
  return $?
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
