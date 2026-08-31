#!/bin/sh
# Print the immutable release identity without creating a tag or release.
# CI performs the same lookup with gh before mutating GitHub.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
TAG="desktop-v$VERSION"
if [ "${1:-}" = "--dry-run" ]; then
  echo "dry-run: would check release '$TAG' and, if absent, build and publish Familiar-$VERSION.dmg"
  echo "dry-run: an existing release means no tag, build, or replacement"
  exit 0
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required (or use --dry-run)" >&2
  exit 2
fi
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "released: $TAG"
  exit 0
fi
echo "unreleased: $TAG"
exit 1
