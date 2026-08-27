#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
TMP=$(mktemp -d);trap 'rm -rf "$TMP"' EXIT
check(){ local d=$1;chmod 600 "$d/familiar.toml";"$ROOT/familiar.sh" --config "$d/familiar.toml" config-check --plugin; }
local_plugin="$TMP/local-plugin";mkdir -p "$local_plugin/contrib/familiar";printf 'familiar_api=1\n[chrome]\nrender_url="http://127.0.0.1:9940/v1/render/golem"\n' >"$local_plugin/contrib/familiar/plugin.toml"
mkdir "$TMP/path";cat >"$TMP/path/familiar.toml" <<EOF
[plugins.golem]
path = "$local_plugin"
[plugins.golem.env]
GOLEM_ENDPOINT = "http://127.0.0.1:9920"
EOF
# config-check verifies that operator plugin overrides are projected both into
# the host merge namespace and into the direct environment consumed by the
# independently owned resident Pi process.
check "$TMP/path"|grep -Fq "plugin_root=$local_plugin"
repo="$TMP/repo";mkdir "$repo";git -C "$repo" init -q;git -C "$repo" config user.email test@example.invalid;git -C "$repo" config user.name test;mkdir -p "$repo/contrib/familiar";printf 'familiar_api=1\n[chrome]\nrender_url="http://127.0.0.1:9940/v1/render/golem"\n' >"$repo/contrib/familiar/plugin.toml";printf 'stale-*\n' >"$repo/.gitignore";git -C "$repo" add .;git -C "$repo" commit -qm fixture;rev=$(git -C "$repo" rev-parse HEAD)
mkdir "$TMP/git";cat >"$TMP/git/familiar.toml" <<EOF
[plugins.golem]
git = "$repo"
rev = "$rev"
EOF
check "$TMP/git"|grep -Fq "plugin_root=$TMP/git/state/plugins/golem/src"
[ "$(git -C "$TMP/git/state/plugins/golem/src" rev-parse HEAD)" = "$rev" ]
cache="$TMP/git/state/plugins/golem/src"
printf 'stale executable\n' >"$cache/stale-executable"
printf 'familiar_api=999\n[chrome]\n' >"$cache/contrib/familiar/stale-plugin.toml"
git -C "$cache" check-ignore -q stale-executable || { echo 'fixture is not ignored' >&2; exit 1; }
check "$TMP/git" >/dev/null
[ ! -e "$cache/stale-executable" ] && [ ! -e "$cache/contrib/familiar/stale-plugin.toml" ] || { echo 'stale cache content survived clean' >&2; exit 1; }
[ -z "$(git -C "$cache" status --porcelain)" ] || { echo 'cached tree is dirty' >&2; exit 1; }
[ "$(git -C "$cache" ls-files | sort)" = "$(git -C "$repo" ls-files | sort)" ] || { echo 'cached tree differs from commit' >&2; exit 1; }
mkdir "$TMP/refuse";cat >"$TMP/refuse/familiar.toml" <<EOF
[plugins.golem]
git = "$repo"
rev = "0000000000000000000000000000000000000000"
EOF
chmod 600 "$TMP/refuse/familiar.toml";if "$ROOT/familiar.sh" --config "$TMP/refuse/familiar.toml" config-check --plugin >/dev/null 2>&1;then echo 'accepted unavailable SHA' >&2;exit 1;fi
echo 'plugin source tests: ok'
