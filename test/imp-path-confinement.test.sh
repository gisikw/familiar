#!/usr/bin/env bash
set -euo pipefail

FAMILIAR=${1:?familiar.sh path required}
IMP_BIN=${2:?imp bin path required}
case ":$PATH:" in
  *":$IMP_BIN:"*) echo "FAIL: imp leaked onto the check shell PATH" >&2; exit 1 ;;
esac

TMP=$(mktemp -d "${TMPDIR:-/tmp}/familiar-imp-path.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state"

cat > "$TMP/bin/pi" <<'EOF'
#!/usr/bin/env bash
{
  printf 'path=%s\n' "$PATH"
  printf 'imp=%s\n' "$(command -v imp || true)"
  # Model-callable Bash is a child of this process and receives the same PATH.
  bash -c 'printf "child=%s\n" "$(command -v imp || true)"'
} > "$PI_CODING_AGENT_DIR/imp-path.tmp"
mv "$PI_CODING_AGENT_DIR/imp-path.tmp" "$PI_CODING_AGENT_DIR/imp-path"
touch "$PI_CODING_AGENT_DIR/ready"
EOF
sed -i "1c#!$(command -v bash)" "$TMP/bin/pi"
chmod 700 "$TMP/bin/pi"

PATH="$TMP/bin:$PATH" \
FAMILIAR_SHELL=pi \
FAMILIAR_IMP_BIN="$IMP_BIN" \
FAMILIAR_CONFIG_PATH="$TMP/absent.toml" \
PI_CODING_AGENT_DIR="$TMP/state" \
FAMILIAR_DEFAULT_PROVIDER=test \
FAMILIAR_DEFAULT_MODEL=test \
bash "$FAMILIAR" pi >/dev/null 2>"$TMP/stderr" &
pid=$!
for _ in $(seq 1 500); do
  [ -f "$TMP/state/ready" ] && break
  kill -0 "$pid" 2>/dev/null || { cat "$TMP/stderr" >&2; wait "$pid"; exit 1; }
  sleep 0.01
done
[ -f "$TMP/state/ready" ] || { echo 'FAIL: timed out waiting for resident stub' >&2; exit 1; }
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true

grep -Fqx "imp=$IMP_BIN/imp" "$TMP/state/imp-path"
grep -Fqx "child=$IMP_BIN/imp" "$TMP/state/imp-path"
case "$(grep '^path=' "$TMP/state/imp-path")" in
  "path=$IMP_BIN:"*) ;;
  *) echo "FAIL: resident PATH was not prefixed with the private imp bin" >&2; cat "$TMP/state/imp-path" >&2; exit 1 ;;
esac

echo 'imp PATH confinement tests: ok'
