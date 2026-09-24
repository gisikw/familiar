#!/usr/bin/env bash
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/worklist-ingress.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
SOCKET="$TMP/familiar.sock"
REQUEST="$TMP/request.jsonl"

# A one-request fake familiar-services server.
printf '%s\n' '{"ok":true,"result":{"item":{"id":"cli-test"},"created":true}}' |
  nc -lU "$SOCKET" >"$REQUEST" &
server=$!
for _ in $(seq 1 50); do [ -S "$SOCKET" ] && break; sleep .02; done
id=$(FAMILIAR_SHELL=pi FAMILIAR_SERVICES_SOCKET="$SOCKET" \
  "$REPO/familiar.sh" worklist-add --summary "private settlement" --body "secret body")
wait "$server"

[ "$id" = cli-test ] || { echo "bad returned id" >&2; exit 1; }
[ "$(jq -r .op "$REQUEST")" = schedule.enqueue ] || { echo "bad operation" >&2; exit 1; }
[ "$(jq -r .args.body "$REQUEST")" = "secret body" ] || { echo "bad envelope" >&2; exit 1; }
# M2 has no file fallback or dual-write.
[ "$(find "$TMP" -type f | wc -l)" -eq 1 ] || { echo "unexpected state file" >&2; exit 1; }
echo "scheduler shell socket ingress: ok"
