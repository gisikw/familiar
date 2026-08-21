#!/usr/bin/env bash
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/familiar config test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
CONFIG="$TMP/path with spaces/familiar.toml"
mkdir -p "$(dirname "$CONFIG")"

fail() { echo "FAIL: $*" >&2; exit 1; }
assert_eq() { [ "$1" = "$2" ] || fail "$3 (got <$1>, expected <$2>)"; }
load() {
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" "$@" bash -c '
    set -euo pipefail
    source "$1/scripts/familiar-config.sh"
    familiar_config_load "$1"
    shift
    "$@"
  ' bash "$REPO"
}

cat >"$CONFIG" <<'TOML'
plain = "a path with spaces"
enabled = true
count = 12
ratio = 1.5
items = ["x", 2, false]
"hyphen-key" = "normalized"
"familiar-already" = "once"
[theme]
accent = "#abc"
[many-levels]
inner_value = "line one\nline two"
TOML
chmod 600 "$CONFIG"
out=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" bash -c '
  set -eu; source "$1/scripts/familiar-config.sh"; familiar_config_load "$1"
  printf "%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s" \
    "$FAMILIAR_PLAIN" "$FAMILIAR_ENABLED" "$FAMILIAR_COUNT" "$FAMILIAR_RATIO" \
    "$FAMILIAR_ITEMS" "$FAMILIAR_HYPHEN_KEY" "$FAMILIAR_ALREADY" "$FAMILIAR_THEME_ACCENT"
' bash "$REPO")
assert_eq "$out" $'a path with spaces\037true\03712\0371.5\037["x",2,false]\037normalized\037once\037#abc' "flatten/type conversion"

out=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" FAMILIAR_PLAIN=ambient bash -c '
  set -eu; source "$1/scripts/familiar-config.sh"; familiar_config_load "$1"
  printf "%s" "$FAMILIAR_PLAIN"
' bash "$REPO")
assert_eq "$out" ambient "ambient FAMILIAR_* precedence"

# A dev shell may replace a file-loaded variable. Re-entry must restore the
# file value, but continue preserving variables that were ambient initially.
out=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" FAMILIAR_COUNT=99 bash -c '
  set -eu; source "$1/scripts/familiar-config.sh"; familiar_config_load "$1"
  FAMILIAR_PLAIN=devshell; FAMILIAR_COUNT=devshell
  familiar_config_load "$1"
  printf "%s/%s" "$FAMILIAR_PLAIN" "$FAMILIAR_COUNT"
' bash "$REPO")
assert_eq "$out" 'a path with spaces/devshell' "recursive precedence"

cat >"$CONFIG" <<'TOML'
pi_offline = 1
anthropic_base_url = "https://example.invalid/v1"
llama_base_url = "http://localhost:9999"
herdr_session = "config-test"
TOML
chmod 600 "$CONFIG"
out=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" bash -c '
  set -eu; source "$1/scripts/familiar-config.sh"; familiar_config_load "$1"
  printf "%s/%s/%s/%s" "$PI_OFFLINE" "$ANTHROPIC_BASE_URL" "$LLAMA_BASE_URL" "$HERDR_SESSION"
' bash "$REPO")
assert_eq "$out" '1/https://example.invalid/v1/http://localhost:9999/config-test' "upstream compatibility exports"

cat >"$CONFIG" <<'TOML'
[familiar]
identity_path = "./identity-grouped"
[pi]
offline = 0
[anthropic]
base_url = "https://grouped.example.invalid"
claude_oauth_token = "token-placeholder"
[openai]
base_url = "https://openai.example.invalid"
api_key = "openai-placeholder"
[stt]
url = "http://localhost:19932"
[tts]
voice = "af_test"
[herdr]
session = "grouped-session"
TOML
chmod 600 "$CONFIG"
out=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" ANTHROPIC_BASE_URL=ambient bash -c '
  set -eu; source "$1/scripts/familiar-config.sh"; familiar_config_load "$1"
  printf "%s|%s|%s|%s|%s|%s|%s|%s|%s" "$FAMILIAR_IDENTITY_PATH" "$PI_OFFLINE" \
    "$ANTHROPIC_BASE_URL" "$CLAUDE_CODE_OAUTH_TOKEN" "$OPENAI_BASE_URL" "$OPENAI_API_KEY" \
    "$FAMILIAR_STT_URL" "$FAMILIAR_TTS_VOICE" "$HERDR_SESSION"
' bash "$REPO")
assert_eq "$out" './identity-grouped|0|ambient|token-placeholder|https://openai.example.invalid|openai-placeholder|http://localhost:19932|af_test|grouped-session' "grouped mapping, aliases, and precedence"

secret='DO_NOT_PRINT_CONFIG_SECRET_7e21'
printf 'token = "unterminated %s\n' "$secret" >"$CONFIG"
chmod 600 "$CONFIG"
set +e
err=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" bash -c \
  'source "$1/scripts/familiar-config.sh"; familiar_config_load "$1"' bash "$REPO" 2>&1)
status=$?
set -e
[ "$status" -ne 0 ] || fail "malformed TOML succeeded"
[[ $err != *"$secret"* ]] || fail "parse error logged secret content"
[[ $err == *'contents suppressed'* ]] || fail "parse error was not generic"

cat >"$CONFIG" <<'TOML'
[anthropic]
claude_oauth_token = 123
TOML
chmod 600 "$CONFIG"
set +e
err=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" bash -c \
  'source "$1/scripts/familiar-config.sh"; familiar_config_load "$1"' bash "$REPO" 2>&1)
status=$?
set -e
[ "$status" -ne 0 ] || fail "non-string Claude token succeeded"
[[ $err == *'contents suppressed'* ]] || fail "secret type error was not suppressed"

printf 'x = "private"\n' >"$CONFIG"
chmod 644 "$CONFIG"
set +e
err=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" bash -c \
  'source "$1/scripts/familiar-config.sh"; familiar_config_load "$1"' bash "$REPO" 2>&1)
status=$?
set -e
[ "$status" -ne 0 ] || fail "insecure mode succeeded"
[[ $err != *private* ]] || fail "mode error logged content"

chmod 600 "$CONFIG"
printf '"a-b" = 1\na_b = 2\n' >"$CONFIG"
set +e
err=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" bash -c \
  'source "$1/scripts/familiar-config.sh"; familiar_config_load "$1"' bash "$REPO" 2>&1)
status=$?
set -e
[ "$status" -ne 0 ] || fail "normalized-key collision succeeded"
[[ $err == *'contents suppressed'* ]] || fail "collision error was not generic"

echo "familiar config tests: ok"
