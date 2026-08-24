#!/usr/bin/env bash
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/familiar-split.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
assert_file() { [ -e "$1" ] || fail "missing $1"; }

# Every path-valued [familiar], [pi], and [subagent] setting is anchored at
# the external TOML directory, even when launched from an unrelated cwd.
CFG="$TMP/private/familiar.toml"; mkdir -p "$(dirname "$CFG")"
cat >"$CFG" <<'TOML'
[familiar]
identity_path = "identity"
handoff_path = "memory/handoffs"
handoff_prompt_path = "memory/prompt.md"
worklist_dir = "memory/worklist"
inbox_dir = "memory/inbox"
log_path = "memory/log.jsonl"
tts_voices_source = "voices"
model_dir = "models"
artifact_dir = "memory/artifacts"
[pi]
coding_agent_dir = "runtime/pi"
[subagent]
dir = "runtime/subagents"
session_dir = "runtime/sessions"
TOML
chmod 600 "$CFG"
out=$(cd / && "$REPO/familiar.sh" --config "$CFG" config-check --paths)
base=$(dirname "$CFG")
for key in config_dir identity handoff handoff_prompt worklist inbox log voices model artifact subagent sessions pi presence agents; do
  line=$(printf '%s\n' "$out" | grep "^$key=") || fail "missing $key"
  case "$line" in *"$base"*) ;; *) fail "$key was not anchored at config directory";; esac
done
[[ "$out" != *'api_key'* ]] || fail 'config output exposed a credential key'

# Init creates the complete scaffold, restrictive config, and does not overwrite.
INSTANCE="$TMP/new"
"$REPO/familiar.sh" init "$INSTANCE" >/dev/null
for d in identity voices state skills extensions; do assert_file "$INSTANCE/$d"; done
[ "$(stat -c '%a' "$INSTANCE/familiar.toml" 2>/dev/null || stat -f '%Lp' "$INSTANCE/familiar.toml")" = 600 ] || fail 'config is not 0600'
cp "$INSTANCE/familiar.toml" "$TMP/config.before"
! "$REPO/familiar.sh" init "$INSTANCE" >/dev/null 2>&1 || fail 'init overwrote existing config'
cmp "$TMP/config.before" "$INSTANCE/familiar.toml" || fail 'config changed after refusal'
printf x > "$TMP/conflict"
! "$REPO/familiar.sh" init "$TMP/conflict" >/dev/null 2>&1 || fail 'init accepted file conflict'
# Bare identity remains absent: init never invents identity content.
[ -z "$(find "$INSTANCE/identity" -mindepth 1 -print -quit)" ] || fail 'init created identity content'

echo 'private instance split tests: ok'
