#!/usr/bin/env bash
set -euo pipefail

REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/familiar-extra-extensions.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/plugin"
: > "$TMP/familiar.toml"
chmod 600 "$TMP/familiar.toml"

cat > "$TMP/bin/pi" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$PI_CODING_AGENT_DIR/cli-args.tmp"
mv "$PI_CODING_AGENT_DIR/cli-args.tmp" "$PI_CODING_AGENT_DIR/cli-args"
touch "$PI_CODING_AGENT_DIR/ready"
exit 0
EOF
cat > "$TMP/bin/nix" <<'EOF'
#!/usr/bin/env bash
# plugin_extensions_json is the only Nix operation: return two host plugin paths.
printf '%s\n' '["/opt/plugin/index.js","/etc/shared/index.js"]'
EOF
chmod 700 "$TMP/bin/pi" "$TMP/bin/nix"

run_pi() {
  local state=$1 pid status attempt
  shift
  local -a extra_env=(-u FAMILIAR_PI_EXTRA_EXTENSIONS_JSON)
  if [ "$#" -gt 0 ]; then
    extra_env=(FAMILIAR_PI_EXTRA_EXTENSIONS_JSON="$1")
  fi
  mkdir -p "$state"
  env -u LLAMA_BASE_URL -u FAMILIAR_MODEL_FILE -u NEED_LLAMA \
    -u _FAMILIAR_CONFIG_EXPLICIT_ENV -u _FAMILIAR_CONFIG_LOADED_ENV \
    "${extra_env[@]}" \
    PATH="$TMP/bin:$PATH" \
    FAMILIAR_SHELL=pi \
    FAMILIAR_CONFIG_PATH="$TMP/familiar.toml" \
    FAMILIAR_PLUGIN_ROOT="$TMP/plugin" \
    PI_CODING_AGENT_DIR="$state" \
    FAMILIAR_DEFAULT_PROVIDER=test \
    FAMILIAR_DEFAULT_MODEL=test \
    "$REPO/familiar.sh" pi >/dev/null 2>"$state/stderr" &
  pid=$!

  # Wait for the Pi stub to confirm that settings generation completed and the
  # complete CLI argument list arrived. A fixed startup timeout races slower
  # evaluators before either contract is observable.
  for attempt in $(seq 1 500); do
    if [ -f "$state/ready" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      if wait "$pid"; then
        status=0
      else
        status=$?
      fi
      return "$status"
    fi
    sleep 0.01
  done

  echo 'FAIL: timed out waiting for Pi settings/argument readiness' >&2
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  return 124
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
[ "$status" -eq 0 ] || { cat "$state/stderr" >&2; exit 1; }

# Built-ins, plugin paths, and host extras all survive; duplicates collapse.
# Use set subtraction for the complete required set, then explicit occurrence
# counts to prove unique merging across plugin and deployment sources.
jq -e --arg root "$REPO/integrations/pi/extensions" '
  ([
    "background", "footer", "handoff", "identity", "private", "stuff", "subscriber",
    "tiamat", "web", "worklist", "zip", "wake"
  ] | map($root + "/" + .)) as $builtins
  | ($builtins - .extensions | length) == 0
    and (.extensions | index($root + "/agents")) == null
    and (.extensions | index("/opt/plugin/index.js")) != null
    and ([.extensions[] | select(. == "/etc/shared/index.js")] | length) == 1
    and ([.extensions[] | select(. == "/etc/familiar-ui-extension/index.js")] | length) == 1
' "$state/settings.json" >/dev/null
if grep -qx -- '--familiar-agents-owner' "$state/cli-args"; then
  echo 'FAIL: dormant Familiar Agents owner flag reached Pi' >&2
  exit 1
fi
grep -qx -- '--continue' "$state/cli-args"

# Unset (as opposed to explicitly empty) defaults to no deployment extensions.
unset_state="$TMP/unset"
set +e
run_pi "$unset_state"
status=$?
set -e
[ "$status" -eq 0 ] || { cat "$unset_state/stderr" >&2; exit 1; }
jq -e '.extensions | index("/opt/plugin/index.js") != null' "$unset_state/settings.json" >/dev/null

echo 'pi extra-extension contract tests: ok'
