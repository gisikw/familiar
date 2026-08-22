#!/usr/bin/env bash
# Regression for an idle drop-serve ignoring TERM while Bash waited on nc.
set -euo pipefail

FAMILIAR=${1:-"$(cd "$(dirname "$0")/.." && pwd)/familiar.sh"}
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/familiar-drop-lifecycle.XXXXXX")
SOCK=$ROOT/serve/testmac.sock
LOG=$ROOT/build-output.log
SERVER=""
KNOWN=""

cleanup() {
  if [ -n "$SERVER" ]; then
    kill -TERM "$SERVER" $KNOWN 2>/dev/null || true
    sleep 0.1
    kill -KILL "$SERVER" $KNOWN 2>/dev/null || true
    wait "$SERVER" 2>/dev/null || true
  fi
  rm -rf "$ROOT"
}
trap cleanup EXIT INT TERM

mkdir -p "$(dirname "$SOCK")"
bash "$FAMILIAR" drop-serve "$SOCK" >"$LOG" 2>&1 &
SERVER=$!
for _ in $(seq 1 50); do
  [ -S "$SOCK" ] && break
  kill -0 "$SERVER" 2>/dev/null || { status=0; wait "$SERVER" || status=$?; cat "$LOG" >&2; exit "$status"; }
  sleep 0.1
done
[ -S "$SOCK" ] || { echo "drop-serve did not create its socket" >&2; exit 1; }

# Exercise a completed exchange before interrupting the next idle listener.
initial_handler=""
for _ in $(seq 1 50); do
  initial_handler=$(cat "$SOCK.fifo.handler-pid" 2>/dev/null || true)
  case $initial_handler in ''|*[!0-9]*) ;; *) break ;; esac
  sleep 0.1
done
[ -n "$initial_handler" ] || { echo "initial handler did not start" >&2; exit 1; }
reply=$(printf 'HELLO\n' | nc -w 2 -U "$SOCK")
case $reply in "OK "*) ;; *) echo "bad HELLO response: $reply" >&2; exit 1;; esac
handler=""
for _ in $(seq 1 50); do
  handler=$(cat "$SOCK.fifo.handler-pid" 2>/dev/null || true)
  case $handler in
    ''|*[!0-9]*) ;;
    "$initial_handler") ;;
    *) [ -e "/proc/$handler" ] && break ;;
  esac
  handler=""
  sleep 0.1
done
[ -n "$handler" ] || { echo "idle handler did not start" >&2; exit 1; }
children=$(cat "/proc/$SERVER/task/$SERVER/children")
KNOWN="$handler $children"

# Model a Nix/test harness unlinking its output capture on cancellation. The
# server demonstrably owns the deleted FD before TERM; no owner may survive it.
rm "$LOG"
readlink "/proc/$SERVER/fd/1" | grep -F "$LOG (deleted)" >/dev/null
kill -TERM "$SERVER"

for _ in $(seq 1 50); do
  alive=""
  for pid in "$SERVER" $KNOWN; do
    state=$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true)
    if [ -n "$state" ] && [ "$state" != Z ]; then alive=1; fi
  done
  [ -z "$alive" ] && break
  sleep 0.1
done
status=0
wait "$SERVER" || status=$?
[ "$status" -eq 143 ] || { echo "drop-serve exited with $status, want 143" >&2; exit 1; }

for pid in "$SERVER" $KNOWN; do
  [ ! -e "/proc/$pid" ] || { echo "drop-serve descendant $pid survived TERM" >&2; exit 1; }
done
[ ! -e "$SOCK" ] || { echo "socket survived TERM" >&2; exit 1; }
[ ! -e "$SOCK.fifo" ] || { echo "fifo survived TERM" >&2; exit 1; }

echo "drop-serve lifecycle: ok"
SERVER=""
KNOWN=""
