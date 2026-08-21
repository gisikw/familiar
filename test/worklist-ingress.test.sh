#!/usr/bin/env bash
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/worklist-ingress.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
ROOT="$TMP/worklist"
mkdir -p "$ROOT/incoming"
chmod 755 "$ROOT" "$ROOT/incoming"

# Portability guard: BSD/macOS mktemp requires the X run at the very end.
grep -F 'mktemp "$incoming/.${id}.tmp.XXXXXX"' "$REPO/familiar.sh" >/dev/null || {
  echo "mktemp template must end in XXXXXX" >&2; exit 1;
}

id=$(umask 022; FAMILIAR_SHELL=pi FAMILIAR_WORKLIST_DIR="$ROOT" \
  "$REPO/familiar.sh" worklist-add --summary "private settlement" --body "secret body")
file="$ROOT/incoming/$id.json"

[ -f "$file" ] || { echo "missing envelope" >&2; exit 1; }
[ "$(stat -c %a "$ROOT")" = 700 ] || { echo "root not 0700" >&2; exit 1; }
[ "$(stat -c %a "$ROOT/incoming")" = 700 ] || { echo "incoming not 0700" >&2; exit 1; }
[ "$(stat -c %a "$file")" = 600 ] || { echo "envelope not 0600" >&2; exit 1; }
[ "$(jq -r .body "$file")" = "secret body" ] || { echo "bad envelope" >&2; exit 1; }
# Atomic ingress leaves exactly one complete public envelope and no temp file.
[ "$(find "$ROOT/incoming" -maxdepth 1 -type f | wc -l)" -eq 1 ] || { echo "unexpected ingress files" >&2; exit 1; }
if find "$ROOT/incoming" -maxdepth 1 -name '.*.tmp.*' -print -quit | grep -q .; then
  echo "temporary envelope leaked" >&2; exit 1
fi
echo "worklist shell ingress portability/permissions: ok"
