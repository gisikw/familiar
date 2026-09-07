#!/usr/bin/env bash
# Resolve the separately tracked familiar-ui flake to its actual Nix-built Pi
# extension. No generated dist tree is copied into Familiar.
set -euo pipefail

usage() { echo "usage: $0 extension|package UI_SOURCE UI_REV" >&2; exit 2; }
[ $# -eq 3 ] || usage
command=$1 source=$2 expected=${3,,}
[[ $source = /* ]] || { echo "familiar-ui: source must be absolute" >&2; exit 1; }
[[ $expected =~ ^[0-9a-f]{40}$ ]] || { echo "familiar-ui: rev must be an exact 40-character Git SHA" >&2; exit 1; }
[ -e "$source/.git" ] || { echo "familiar-ui: source is not a Git checkout" >&2; exit 1; }
[ ! -L "$source" ] || { echo "familiar-ui: refusing symlink source" >&2; exit 1; }
source=$(realpath -e "$source")
actual=$(git -C "$source" rev-parse --verify HEAD 2>/dev/null || true)
[ "${actual,,}" = "$expected" ] || { echo "familiar-ui: checkout SHA mismatch (wanted $expected, got ${actual:-unknown})" >&2; exit 1; }
[ -z "$(git -C "$source" status --porcelain --untracked-files=normal)" ] \
  || { echo "familiar-ui: tracked source checkout is dirty" >&2; exit 1; }
[ -f "$source/flake.nix" ] && [ -f "$source/flake.lock" ] \
  || { echo "familiar-ui: pinned checkout has no locked production flake" >&2; exit 1; }
command -v nix >/dev/null || { echo "familiar-ui: Nix is required to resolve the production package" >&2; exit 1; }

# path: copies only the clean tracked flake source into Nix evaluation. The
# ignored local dist/node_modules trees can never influence this artifact.
mapfile -t outputs < <(nix build --no-link --print-out-paths "path:$source#familiar-ui")
[ "${#outputs[@]}" -eq 1 ] || { echo "familiar-ui: expected exactly one Nix output" >&2; exit 1; }
package=$(realpath -e "${outputs[0]}")
root="$package/share/familiar-ui"
required=(
  packages/protocol/dist/index.js
  packages/bridge/dist/index.js packages/bridge/dist/journal.js
  packages/extension/dist/index.js
  web/index.html
)
for relative in "${required[@]}"; do
  [ -f "$root/$relative" ] || { echo "familiar-ui: Nix package lacks $relative" >&2; exit 1; }
done
for workspace in protocol bridge extension; do
  resolved=$(realpath -e "$root/node_modules/@familiar-ui/$workspace" 2>/dev/null || true)
  [ "$resolved" = "$root/packages/$workspace" ] \
    || { echo "familiar-ui: packaged npm workspace $workspace is missing or escapes package" >&2; exit 1; }
done
zod=$(realpath -e "$root/node_modules/zod" 2>/dev/null || true)
case "$zod" in "$root"/node_modules/*) ;; *) echo "familiar-ui: packaged zod dependency is missing or escapes package" >&2; exit 1 ;; esac

case "$command" in
  extension) printf '%s\n' "$root/packages/extension/dist/index.js" ;;
  package) printf '%s\n' "$package" ;;
  *) usage ;;
esac
