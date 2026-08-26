#!/usr/bin/env bash
# Verifies the viewer-facing render contract is the generic host endpoint and
# that the SSH/native `connect` path performs plugin preparation, so an external
# instance gets host chrome without exporting any plugin-specific URL.
set -euo pipefail
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# A trusted local plugin whose own render_url is deliberately plugin-specific;
# it must never surface in the viewer-facing FAMILIAR_RENDER_URL.
plugin="$TMP/plugin"; mkdir -p "$plugin/contrib/familiar"
printf 'familiar_api=1\n[chrome]\nrender_url="http://127.0.0.1:9940/plugin/golem/render"\n' \
  >"$plugin/contrib/familiar/plugin.toml"

mkdir "$TMP/inst"; cat >"$TMP/inst/familiar.toml" <<EOF
[plugins.golem]
path = "$plugin"
EOF
chmod 600 "$TMP/inst/familiar.toml"

out=$("$ROOT/familiar.sh" --config "$TMP/inst/familiar.toml" config-check --plugin)
printf '%s\n' "$out"

# The viewer endpoint must be the generic host aggregate, never plugin-scoped.
echo "$out" | grep -Eq 'render_url=http://127\.0\.0\.1:[0-9]+/v1/render$' \
  || { echo 'FAIL: FAMILIAR_RENDER_URL is not the generic /v1/render endpoint' >&2; exit 1; }
echo "$out" | grep -q '/v1/render/golem' \
  && { echo 'FAIL: viewer render URL leaked a plugin-specific path' >&2; exit 1; }
echo "$out" | grep -Fq "plugin_root=$plugin" \
  || { echo 'FAIL: plugin was not prepared' >&2; exit 1; }

# The `connect` command must call prepare_plugin so an external instance gets a
# render URL without manual plugin exports. Assert the wiring in the script.
grep -A6 '^viewer_connect()' "$ROOT/familiar.sh" | grep -q 'prepare_plugin' \
  || { echo 'FAIL: viewer_connect does not perform plugin preparation' >&2; exit 1; }

echo 'render-endpoint tests: ok'
