#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
TMP=$(mktemp -d);trap 'rm -rf "$TMP"' EXIT
check(){ local d=$1;chmod 600 "$d/familiar.toml";"$ROOT/familiar.sh" --config "$d/familiar.toml" config-check --plugin; }
local_plugin="$TMP/local-plugin";mkdir -p "$local_plugin/contrib/familiar";printf 'familiar_api=1\n' >"$local_plugin/contrib/familiar/plugin.toml"
mkdir "$TMP/path";cat >"$TMP/path/familiar.toml" <<EOF
[plugins.golem]
path = "$local_plugin"
EOF
check "$TMP/path"|grep -Fq "plugin_root=$local_plugin"
repo="$TMP/repo";mkdir "$repo";git -C "$repo" init -q;git -C "$repo" config user.email test@example.invalid;git -C "$repo" config user.name test;mkdir -p "$repo/contrib/familiar";printf 'familiar_api=1\n' >"$repo/contrib/familiar/plugin.toml";git -C "$repo" add .;git -C "$repo" commit -qm fixture;rev=$(git -C "$repo" rev-parse HEAD)
mkdir "$TMP/git";cat >"$TMP/git/familiar.toml" <<EOF
[plugins.golem]
git = "$repo"
rev = "$rev"
EOF
check "$TMP/git"|grep -Fq "plugin_root=$TMP/git/state/plugins/golem/src"
[ "$(git -C "$TMP/git/state/plugins/golem/src" rev-parse HEAD)" = "$rev" ]
mkdir "$TMP/refuse";cat >"$TMP/refuse/familiar.toml" <<EOF
[plugins.golem]
git = "$repo"
rev = "0000000000000000000000000000000000000000"
EOF
chmod 600 "$TMP/refuse/familiar.toml";if "$ROOT/familiar.sh" --config "$TMP/refuse/familiar.toml" config-check --plugin >/dev/null 2>&1;then echo 'accepted unavailable SHA' >&2;exit 1;fi
echo 'plugin source tests: ok'
