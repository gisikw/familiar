#!/usr/bin/env bash
set -euo pipefail

REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/familiar-extra-extensions.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/plugin"

cat > "$TMP/bin/pi" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$TMP/bin/nix" <<'EOF'
#!/usr/bin/env bash
# plugin_extensions_json is the only Nix operation: return two host plugin paths.
printf '%s\n' '["/opt/plugin/index.js","/etc/shared/index.js"]'
EOF
chmod 700 "$TMP/bin/pi" "$TMP/bin/nix"

run_pi() {
  local state=$1 value=$2
  mkdir -p "$state"
  env -u LLAMA_BASE_URL -u FAMILIAR_MODEL_FILE -u NEED_LLAMA \
    PATH="$TMP/bin:$PATH" \
    FAMILIAR_SHELL=pi \
    FAMILIAR_PLUGIN_ROOT="$TMP/plugin" \
    PI_CODING_AGENT_DIR="$state" \
    FAMILIAR_DEFAULT_PROVIDER=test \
    FAMILIAR_DEFAULT_MODEL=test \
    FAMILIAR_PI_EXTRA_EXTENSIONS_JSON="$value" \
    timeout 0.5 "$REPO/familiar.sh" pi >/dev/null 2>"$state/stderr"
  return $?
}

expect_rejected_unchanged() {
  local name=$1 value=$2 state="$TMP/reject-$1"
  mkdir -p "$state"
  printf '%s\n' '{"sentinel":{"preserve":true},"extensions":["/old/value"]}' > "$state/settings.json"
  cp "$state/settings.json" "$state/before"
  local status
  set +e
  run_pi "$state" "$value"
  status=$?
  set -e
  [ "$status" -ne 0 ] && [ "$status" -ne 124 ] || {
    echo "FAIL: $name extra-extension input was accepted" >&2
    exit 1
  }
  [ "$(<"$state/before")" = "$(<"$state/settings.json")" ] || {
    echo "FAIL: $name rewrote settings before failing closed" >&2
    exit 1
  }
  grep -q 'invalid FAMILIAR_PI_EXTRA_EXTENSIONS_JSON' "$state/stderr"
}

expect_rejected_unchanged malformed '{'
expect_rejected_unchanged non-array '{"path":"/absolute"}'
expect_rejected_unchanged relative '["relative/index.js"]'
expect_rejected_unchanged empty-path '[""]'
expect_rejected_unchanged empty-value ''
over_limit=$(jq -cn '[range(17) | "/extension/\(.)"]')
expect_rejected_unchanged over-limit "$over_limit"

state="$TMP/success"
set +e
run_pi "$state" '["/etc/shared/index.js","/etc/familiar-ui-extension/index.js","/etc/familiar-ui-extension/index.js"]'
status=$?
set -e
[ "$status" -eq 124 ] || { cat "$state/stderr" >&2; exit 1; }

# Built-ins, plugin paths, and host extras all survive; duplicates collapse.
# Use set subtraction for the complete required set, then explicit occurrence
# counts to prove unique merging across plugin and deployment sources.
jq -e --arg root "$REPO/integrations/pi/extensions" '
  ([
    "footer", "handoff", "identity", "stuff", "subscriber",
    "tiamat", "web", "worklist", "zip", "wake"
  ] | map($root + "/" + .)) as $builtins
  | ($builtins - .extensions | length) == 0
    and (.extensions | index("/opt/plugin/index.js")) != null
    and ([.extensions[] | select(. == "/etc/shared/index.js")] | length) == 1
    and ([.extensions[] | select(. == "/etc/familiar-ui-extension/index.js")] | length) == 1
' "$state/settings.json" >/dev/null

# Unset (as opposed to explicitly empty) defaults to no deployment extensions.
unset_state="$TMP/unset"
mkdir -p "$unset_state"
set +e
env -u FAMILIAR_PI_EXTRA_EXTENSIONS_JSON -u LLAMA_BASE_URL -u FAMILIAR_MODEL_FILE -u NEED_LLAMA \
  PATH="$TMP/bin:$PATH" FAMILIAR_SHELL=pi FAMILIAR_PLUGIN_ROOT="$TMP/plugin" \
  PI_CODING_AGENT_DIR="$unset_state" FAMILIAR_DEFAULT_PROVIDER=test FAMILIAR_DEFAULT_MODEL=test \
  timeout 0.5 "$REPO/familiar.sh" pi >/dev/null 2>"$unset_state/stderr"
status=$?
set -e
[ "$status" -eq 124 ] || { cat "$unset_state/stderr" >&2; exit 1; }
jq -e '.extensions | index("/opt/plugin/index.js") != null' "$unset_state/settings.json" >/dev/null

echo 'pi extra-extension contract tests: ok'
