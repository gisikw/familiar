#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root/vendor/libghostty-vt"
exec "${ZIG:-zig}" build -Demit-lib-vt -Doptimize=ReleaseFast "$@"
