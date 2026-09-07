#!/usr/bin/env bash
set -euo pipefail
REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
RESOLVE="$REPO/scripts/familiar-ui-extension.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/familiar-ui-integration.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
UI="$TMP/familiar-ui"
OUT="$TMP/nix/store/familiar-ui-test"
mkdir -p "$UI" "$OUT/share/familiar-ui/packages"/{protocol,bridge,extension}/dist \
  "$OUT/share/familiar-ui/web" "$OUT/share/familiar-ui/node_modules/@familiar-ui" \
  "$OUT/share/familiar-ui/node_modules/zod" "$TMP/bin"
cat > "$UI/.gitignore" <<'EOF'
node_modules/
packages/*/dist/
EOF
printf '{ outputs = _: {}; }\n' > "$UI/flake.nix"
printf '{}\n' > "$UI/flake.lock"
git -C "$UI" init -q
git -C "$UI" config user.name test
git -C "$UI" config user.email test@example.invalid
git -C "$UI" add .
git -C "$UI" commit -qm fixture
REV=$(git -C "$UI" rev-parse HEAD)
# This deliberately stale ignored artifact must never be selected; the resolver
# may return only the Nix package's extension.
mkdir -p "$UI/packages/extension/dist"
printf 'stale\n' > "$UI/packages/extension/dist/index.js"
printf 'export {};\n' > "$OUT/share/familiar-ui/packages/protocol/dist/index.js"
printf 'export {};\n' > "$OUT/share/familiar-ui/packages/bridge/dist/index.js"
printf 'export {};\n' > "$OUT/share/familiar-ui/packages/bridge/dist/journal.js"
printf 'export default function () {};\n' > "$OUT/share/familiar-ui/packages/extension/dist/index.js"
printf '<html></html>\n' > "$OUT/share/familiar-ui/web/index.html"
for package in protocol bridge extension; do
  ln -s "../../packages/$package" "$OUT/share/familiar-ui/node_modules/@familiar-ui/$package"
done
cat > "$TMP/bin/nix" <<EOF
#!/usr/bin/env bash
[ "\$1 \$2 \$3" = 'build --no-link --print-out-paths' ] || exit 90
case "\$4" in path:"$UI"#familiar-ui) ;; *) exit 91 ;; esac
printf '%s\\n' '$OUT'
EOF
chmod 700 "$TMP/bin/nix"

resolved=$(PATH="$TMP/bin:$PATH" bash "$RESOLVE" extension "$UI" "$REV")
[ "$resolved" = "$OUT/share/familiar-ui/packages/extension/dist/index.js" ]
[ "$(PATH="$TMP/bin:$PATH" bash "$RESOLVE" package "$UI" "$REV")" = "$OUT" ]
[ "$resolved" != "$UI/packages/extension/dist/index.js" ]

# Exact revision and clean tracked-source checks fail closed before Nix.
if PATH="$TMP/bin:$PATH" bash "$RESOLVE" extension "$UI" 0000000000000000000000000000000000000000 >/dev/null 2>&1; then
  echo 'wrong familiar-ui revision was accepted' >&2; exit 1
fi
printf 'dirty\n' >> "$UI/flake.nix"
if PATH="$TMP/bin:$PATH" bash "$RESOLVE" extension "$UI" "$REV" >/dev/null 2>&1; then
  echo 'dirty familiar-ui checkout was accepted' >&2; exit 1
fi

echo 'familiar-ui integration contract: PASS'
