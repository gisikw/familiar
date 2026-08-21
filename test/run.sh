#!/usr/bin/env bash
# Subscriber extension regression harness: synthetic pi events → SSE egress,
# segmentation, synthesis, privacy, interruption, replay. No live session.
# Requires bun (nix shell nixpkgs#bun if not in a devshell that has it).
set -euo pipefail
cd "$(dirname "$0")"

rm -f /tmp/familiar-test-log.*

bun mock-tts.ts &
MOCK=$!
FAMILIAR_SUBSCRIBER_PORT=17777 \
FAMILIAR_TTS_URL=http://localhost:17998 \
FAMILIAR_STT_URL=http://localhost:9932 \
  nix develop ..#gateway -c node --experimental-transform-types ../services/gateway/src/main.ts &
GATEWAY=$!
trap 'kill $MOCK $GATEWAY 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  curl -fsS http://localhost:17777/health >/dev/null 2>&1 && break
  kill -0 "$GATEWAY" 2>/dev/null || { wait "$GATEWAY"; exit 1; }
  sleep 0.1
done
curl -fsS http://localhost:17777/health >/dev/null

bun harness.ts

# Zip extension: markers, scheduled editorial branching, paged recommendations,
# and customized /tree summaries. Self-contained; model calls are stubbed.
bun zip.ts
