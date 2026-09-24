#!/usr/bin/env bash
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat > "$TMP/bin/pi" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP/bin/pi"

run_pi_once() {
  local state=$1
  shift
  mkdir -p "$state"
  # The fake Pi exits after the one systemd-owned invocation writes the cache.
  set +e
  env -u LLAMA_BASE_URL -u FAMILIAR_MODEL_FILE -u NEED_LLAMA \
    PATH="$TMP/bin:$PATH" \
    FAMILIAR_SHELL=pi \
    PI_CODING_AGENT_DIR="$state" \
    FAMILIAR_DEFAULT_PROVIDER=tiamat \
    FAMILIAR_DEFAULT_MODEL=remote-model \
    "$@" "$REPO/familiar.sh" pi >/dev/null 2>"$state/stderr"
  local status=$?
  set -e
  [ "$status" -eq 0 ] || { cat "$state/stderr" >&2; return 1; }
  ! grep -q 'unbound variable' "$state/stderr"
}

run_pi_once "$TMP/remote"
jq -e 'type == "object" and length == 0' "$TMP/remote/models-store.json" >/dev/null

run_pi_once "$TMP/local" \
  LLAMA_BASE_URL=http://127.0.0.1:9931 \
  FAMILIAR_MODEL_FILE=model.gguf
jq -e '
  .["llama.cpp"].models[0]
  | .id == "model"
    and .name == "model"
    and .baseUrl == "http://127.0.0.1:9931/v1"
' "$TMP/local/models-store.json" >/dev/null

printf '%s\n' 'pi model-store tests passed'
