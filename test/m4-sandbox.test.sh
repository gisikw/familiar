#!/usr/bin/env bash
# M4a lifecycle sandbox. Every socket/state/unit double is created by the tests
# under their temporary directory; this never names deployment paths or units.
set -euo pipefail
repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)

# The Go lifecycle test uses a PATH-local fake sudo/systemctl, fake scheduler
# and resident Unix sockets: fork -> merge/close -> clean shutdown request.
nix shell nixpkgs#go -c bash -c \
  'cd "$1/packages/imp" && CGO_ENABLED=0 go test ./internal/cli -run "Test(ForkCreatesStateAndStartsUnit|MergeAndCloseEnqueueMarkerAndExit|ForksListsSystemctlState)$"' _ "$repo"

# The Pi-package helper test clones a synthetic session in a temp tree and
# proves its prompt/tool digest and inherited entries are identical. The merge
# renderer test is the fake parent endpoint receiving the scheduler note.
(cd "$repo/integrations/pi/extensions" && nix develop --no-write-lock-file .. -c \
  bun test tiamat/fork-prefix.test.ts scheduler/merge.test.ts)

echo 'M4a sandbox: fork -> merge -> parent note: PASS'
