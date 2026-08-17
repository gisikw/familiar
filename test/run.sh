#!/usr/bin/env bash
# Subscriber extension regression harness: synthetic pi events → SSE egress,
# segmentation, synthesis, privacy, interruption, replay. No live session.
# Requires bun (nix shell nixpkgs#bun if not in a devshell that has it).
set -euo pipefail
cd "$(dirname "$0")"

rm -f /tmp/familiar-test-log.*

bun mock-tts.ts &
MOCK=$!
trap 'kill $MOCK 2>/dev/null || true' EXIT
sleep 0.5

bun harness.ts
