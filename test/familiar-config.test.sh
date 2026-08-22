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
[familiar]
plain = "a path with spaces"
enabled = true
count = 12
ratio = 1.5
items = ["x", 2, false]
"hyphen-key" = "normalized"
already = "once"
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

# Flat top-level keys are no longer supported: they collide with the grouped
# canonical forms after flattening, so the loader rejects them with a generic
# (secret-suppressed) diagnostic rather than exporting anything.
for flat in 'pi_offline = 1' \
            'anthropic_base_url = "https://example.invalid/v1"' \
            'tts_url = "DO_NOT_PRINT_FLAT_SECRET_a91"' \
            'herdr_session = "config-test"'; do
  printf '%s\n' "$flat" >"$CONFIG"; chmod 600 "$CONFIG"
  set +e
  err=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" bash -c \
    'source "$1/scripts/familiar-config.sh"; familiar_config_load "$1"' bash "$REPO" 2>&1)
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "flat top-level key accepted: $flat"
  [[ $err == *'canonical table'* ]] || fail "flat key diagnostic not actionable: $flat"
  [[ $err != *DO_NOT_PRINT_FLAT_SECRET* ]] || fail "flat key diagnostic exposed contents"
done

cat >"$CONFIG" <<'TOML'
[familiar]
identity_path = "./identity-grouped"
[pi]
offline = 0
[anthropic]
base_url = "https://grouped.example.invalid"
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
  printf "%s|%s|%s|%s|%s|%s|%s|%s" "$FAMILIAR_IDENTITY_PATH" "$PI_OFFLINE" \
    "$ANTHROPIC_BASE_URL" "$OPENAI_BASE_URL" "$OPENAI_API_KEY" \
    "$FAMILIAR_STT_URL" "$FAMILIAR_TTS_VOICE" "$HERDR_SESSION"
' bash "$REPO")
assert_eq "$out" './identity-grouped|0|ambient|https://openai.example.invalid|openai-placeholder|http://localhost:19932|af_test|grouped-session' "grouped mapping, aliases, and precedence"

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
printf '[theme]\n"a-b" = 1\na_b = 2\n' >"$CONFIG"
set +e
err=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" bash -c \
  'source "$1/scripts/familiar-config.sh"; familiar_config_load "$1"' bash "$REPO" 2>&1)
status=$?
set -e
[ "$status" -ne 0 ] || fail "normalized-key collision succeeded"
[[ $err == *'contents suppressed'* ]] || fail "collision error was not generic"

# A successful same-process reload clears only exports owned by the prior pass.
NEXT="$TMP/next.toml"
printf '[pi]\noffline = 1\n' >"$CONFIG"
printf '[pi]\ntelemetry = 0\n' >"$NEXT"
chmod 600 "$CONFIG" "$NEXT"
out=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" PI_SKIP_VERSION_CHECK=ambient bash -c '
  set -eu; source "$1/scripts/familiar-config.sh"; familiar_config_load "$1"
  cp "$2" "$FAMILIAR_CONFIG_PATH"; chmod 600 "$FAMILIAR_CONFIG_PATH"; familiar_config_load "$1"
  offline=present; [[ ${PI_OFFLINE+x} ]] || offline=cleared
  rm "$FAMILIAR_CONFIG_PATH"; familiar_config_load "$1"
  telemetry=present; [[ ${PI_TELEMETRY+x} ]] || telemetry=cleared
  printf "%s/%s/%s" "$offline" "$telemetry" "$PI_SKIP_VERSION_CHECK"
' bash "$REPO" "$NEXT")
assert_eq "$out" 'cleared/cleared/ambient' "same-session removal provenance"

# Exported provenance markers survive exec re-entry without turning prior file
# values into ambient configuration.
OLD="$TMP/old.toml"
printf '[pi]\noffline = 1\n' >"$OLD"; chmod 600 "$OLD"
out=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$OLD" bash -c '
  set -eu; source "$1/scripts/familiar-config.sh"; familiar_config_load "$1"
  cp "$2" "$FAMILIAR_CONFIG_PATH"; chmod 600 "$FAMILIAR_CONFIG_PATH"
  exec bash -c '\''set -eu; source "$1/scripts/familiar-config.sh"; familiar_config_load "$1"; [[ ! ${PI_OFFLINE+x} && ${PI_TELEMETRY+x} ]] && printf cutover'\'' bash "$1"
' bash "$REPO" "$NEXT")
assert_eq "$out" cutover "exec re-entry configuration cutover"

# Malformed optional config fails ordinary launch and validation, while the
# bounded operational ingress remains available using ambient/default values.
printf 'broken = "DO_NOT_PRINT_RECOVERY_SECRET\n' >"$CONFIG"; chmod 600 "$CONFIG"
set +e
err=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" \
  "$REPO/familiar.sh" config-check 2>&1); status=$?
set -e
[ "$status" -ne 0 ] || fail "config-check accepted malformed TOML"
[[ $err == *'validation failed'* && $err != *DO_NOT_PRINT_RECOVERY_SECRET* ]] || fail "config-check diagnostic"
set +e
err=$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" \
  "$REPO/familiar.sh" pi 2>&1); status=$?
set -e
[ "$status" -ne 0 ] || fail "ordinary launch accepted malformed TOML"
[[ $err == *'startup refused'* && $err != *DO_NOT_PRINT_RECOVERY_SECRET* ]] || fail "ordinary launch failure policy"
# age is intentionally not a recovery bypass: without parsed FAMILIAR_AGE_KEY it
# could create a default key and overwrite an arbitrary requested target.
AGE_TARGET="$TMP/must-not-be-created.age"
set +e
err=$(printf 'placeholder' | env -i PATH="$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" \
  "$REPO/familiar.sh" age "$AGE_TARGET" 2>&1); status=$?
set -e
[ "$status" -ne 0 ] || fail "age bypassed malformed config"
[ ! -e "$AGE_TARGET" ] || fail "blocked age created its target"
[[ $err == *'startup refused'* && $err != *"continuing 'age'"* && $err != *DO_NOT_PRINT_RECOVERY_SECRET* ]] || fail "age failure policy"
mkdir -p "$TMP/bin"
cat >"$TMP/bin/jq" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"placeholder":true}'
SH
chmod +x "$TMP/bin/jq"
out=$(env -i PATH="$TMP/bin:$PATH" HOME="${HOME:-/tmp}" FAMILIAR_CONFIG_PATH="$CONFIG" \
  FAMILIAR_WORKLIST_DIR="$TMP/recovery-worklist" "$REPO/familiar.sh" worklist-add --summary placeholder 2>"$TMP/recovery.err")
[[ $out == cli-* ]] || fail "worklist recovery verb unavailable"
[[ $(<"$TMP/recovery.err") == *"continuing 'worklist-add'"* ]] || fail "recovery warning missing"

 echo "familiar config tests: ok"
