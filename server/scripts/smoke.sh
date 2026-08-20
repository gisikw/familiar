#!/usr/bin/env bash
# Headless smoke test for the familiar server. Uses a plain shell for the PTY
# attach (FAMILIAR_ATTACH_CMD) so it runs without herdr. Requires: node 22,
# curl. Run from server/ inside a shell that has node on PATH.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=17692
export FAMILIAR_SERVER_PORT=$PORT
export FAMILIAR_SERVER_HOST=127.0.0.1
# Stand-in attach for the smoke: an ABSOLUTE-path, non-interactive shell.
# node-pty spawns via execvp(), which resolves a *bare* command name against
# the child's PATH — in a pure/stripped devShell that PATH can be empty, so
# `bash ...` fails with "execvp(3) failed: No such file or directory". Using
# $(command -v bash) sidesteps PATH resolution entirely, and dropping -i avoids
# interactive job-control quirks (SIGTTOU / "no job control" noise) in envs
# with no controlling tty. Byte-in→byte-out is proven either way. The real
# production attach (FAMILIAR_ATTACH_CMD -> herdr) must likewise be reachable
# on the services-pane PATH; see README.
export FAMILIAR_ATTACH_CMD="$(command -v bash) --norc"
export FAMILIAR_DEBUG_LEVEL=error

pass=0; fail=0
ok()   { echo "PASS: $1"; pass=$((pass+1)); }
bad()  { echo "FAIL: $1"; fail=$((fail+1)); }

node --experimental-transform-types src/main.ts &
SRV=$!
trap 'kill $SRV 2>/dev/null; wait $SRV 2>/dev/null' EXIT
# wait for listen
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.1; done

# 1. health
curl -fsS "http://127.0.0.1:$PORT/health" | grep -q '"ok":true' && ok "health" || bad "health"

# 2. terminal HTML + assets
curl -fsS "http://127.0.0.1:$PORT/terminal" | grep -q '<title>Familiar Terminal' && ok "/terminal HTML" || bad "/terminal HTML"
curl -fsS "http://127.0.0.1:$PORT/" | grep -q 'terminal.js' && ok "/ HTML" || bad "/ HTML"
curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/vendor/restty.esm.js" | grep -q 200 && ok "restty asset" || bad "restty asset"
curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/fonts/OpenMoji-black-glyf.ttf" | grep -q 200 && ok "font asset" || bad "font asset"
curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/vendor/emoji.json" | grep -q 200 && ok "emoji.json" || bad "emoji.json"
# traversal guard
code=$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/vendor/../package.json" 2>/dev/null)
[ "$code" = "404" ] || [ "$code" = "403" ] && ok "traversal guarded ($code)" || bad "traversal guarded ($code)"

# 3. SSE attach + replay + ingest round-trip.
# Start an SSE listener, then POST an ingest publish; the event must appear.
SSE_OUT=$(mktemp)
curl -fsS -N "http://127.0.0.1:$PORT/stream" >"$SSE_OUT" 2>/dev/null &
CURL_SSE=$!
sleep 0.4
# session event should be first
grep -q '"event":"session"' "$SSE_OUT" && ok "SSE session event" || bad "SSE session event"
# ingest a publish
curl -fsS -X POST "http://127.0.0.1:$PORT/ingest" -H 'Content-Type: application/json' \
  -d '{"kind":"publish","event":{"event":"message","id":1,"role":"assistant","content":"hello from ingest"}}' >/dev/null
sleep 0.3
grep -q 'hello from ingest' "$SSE_OUT" && ok "ingest→SSE round-trip" || bad "ingest→SSE round-trip"

# replay: a NEW attach should immediately receive the published history event
REPLAY=$(curl -fsS -N --max-time 0.6 "http://127.0.0.1:$PORT/stream" 2>/dev/null)
echo "$REPLAY" | grep -q 'hello from ingest' && ok "history replay on reattach" || bad "history replay on reattach"

# session re-mint: ingest a session envelope, new attach gets a fresh epoch and no history
SID1=$(echo "$REPLAY" | grep -o '"event":"session","id":"[^"]*"' | head -1)
curl -fsS -X POST "http://127.0.0.1:$PORT/ingest" -H 'Content-Type: application/json' -d '{"kind":"session"}' >/dev/null
sleep 0.2
REPLAY2=$(curl -fsS -N --max-time 0.6 "http://127.0.0.1:$PORT/stream" 2>/dev/null)
if echo "$REPLAY2" | grep -q 'hello from ingest'; then bad "session re-mint clears history"; else ok "session re-mint clears history"; fi

kill $CURL_SSE 2>/dev/null

# 4. ingress → /relay round-trip. Subscribe to /relay, POST /submit, expect a
# submit command to arrive on /relay.
RELAY_OUT=$(mktemp)
curl -fsS -N "http://127.0.0.1:$PORT/relay" >"$RELAY_OUT" 2>/dev/null &
CURL_RELAY=$!
sleep 0.3
curl -fsS -X POST "http://127.0.0.1:$PORT/submit" -H 'Content-Type: application/json' \
  -d '{"type":"text","content":"hi there","id":42}' >/dev/null
sleep 0.3
grep -q '"type":"submit"' "$RELAY_OUT" && grep -q 'hi there' "$RELAY_OUT" && ok "submit→/relay" || bad "submit→/relay"
# cancel
curl -fsS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/cancel" | grep -q 204 && ok "cancel 204" || bad "cancel 204"
sleep 0.2
grep -q '"type":"cancel"' "$RELAY_OUT" && ok "cancel→/relay" || bad "cancel→/relay"
kill $CURL_RELAY 2>/dev/null

# 5. WS PTY bridge echo. Use node's ws client to attach and drive a shell.
node "$(dirname "$0")/ws-smoke.mjs" "ws://127.0.0.1:$PORT/pty" && ok "WS PTY echo" || bad "WS PTY echo"

echo "----"
echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
