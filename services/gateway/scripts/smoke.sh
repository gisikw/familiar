#!/usr/bin/env bash
# Headless smoke test for the familiar server. Uses a plain shell for the PTY
# attach (FAMILIAR_ATTACH_CMD) so it runs without herdr. Requires: node 22,
# curl. Run from services/gateway/ inside a shell that has node on PATH.
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

# /upload config, set BEFORE the server starts (the server reads its OWN env).
# Drops land in a throwaway dir. The notify step is faked with a shell override
# so the smoke NEVER prompts a real herdr agent: it exits 0 normally (proving
# the notify wiring), but non-zero for any drop whose path contains FAILME
# (proving graceful failure -> notified:false, file still saved).
export FAMILIAR_DROPS_DIR="$(mktemp -d)"
export FAMILIAR_UPLOAD_NOTIFY_CMD='case "$FAMILIAR_DROP_PATH" in *FAILME*) exit 7;; *) exit 0;; esac'

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

# 6. POST /upload round-trips. The herdr notify step is faked via
# FAMILIAR_UPLOAD_NOTIFY_CMD (exported above) so no real agent is ever prompted;
# both success (notified:true) and graceful failure (notified:false) are
# asserted. Drops go to $FAMILIAR_DROPS_DIR.
DROPS="$FAMILIAR_DROPS_DIR"
UP="http://127.0.0.1:$PORT/upload"

# 6a. raw body with ?name= — notify override succeeds -> notified:true.
R=$(curl -fsS -X POST "$UP?name=shot.png" \
  --data-binary $'\x89PNG\r\nrawbytes' -H 'Content-Type: application/octet-stream' 2>/dev/null)
echo "$R" | grep -q '"ok":true' && ok "upload raw ok" || bad "upload raw ok ($R)"
echo "$R" | grep -q '"notified":true' && ok "upload raw notified (override succeeds)" || bad "upload raw notified ($R)"
PPATH=$(echo "$R" | grep -o '"path":"[^"]*"' | head -1 | sed 's/"path":"//;s/"//')
[ -f "$PPATH" ] && ok "upload raw file written" || bad "upload raw file written ($PPATH)"
echo "$PPATH" | grep -q '__shot.png$' && ok "upload raw sanitized+timestamped" || bad "upload raw name ($PPATH)"

# 6b. multipart/form-data (browser FormData path).
TMPF=$(mktemp); printf 'hello-multipart' >"$TMPF"
R2=$(curl -fsS -X POST "$UP" -F "file=@$TMPF;filename=pic.jpg" 2>/dev/null)
echo "$R2" | grep -q '"ok":true' && ok "upload multipart ok" || bad "upload multipart ok ($R2)"
MPATH=$(echo "$R2" | grep -o '"path":"[^"]*"' | head -1 | sed 's/"path":"//;s/"//')
[ -f "$MPATH" ] && [ "$(cat "$MPATH")" = "hello-multipart" ] && ok "upload multipart bytes" || bad "upload multipart bytes"
echo "$MPATH" | grep -q '__pic.jpg$' && ok "upload multipart name" || bad "upload multipart name ($MPATH)"
rm -f "$TMPF"

# 6c. filename sanitization: path traversal + illegal chars stripped, and the
# result stays contained in the drops dir.
R3=$(curl -fsS -X POST "$UP?name=../../etc/pa%20ss;wd" \
  --data-binary 'x' -H 'Content-Type: application/octet-stream' 2>/dev/null)
SPATH=$(echo "$R3" | grep -o '"path":"[^"]*"' | head -1 | sed 's/"path":"//;s/"//')
case "$SPATH" in
  "$DROPS"/*) case "$(basename "$SPATH")" in *..*|*/*) bad "sanitize traversal ($SPATH)";; *) ok "sanitize traversal ($SPATH)";; esac;;
  *) bad "sanitize escaped drops dir ($SPATH)";;
esac

# 6d. notify graceful failure: FAILME in the name makes the override exit 7 ->
# notified:false but ok:true, file still saved with an error string.
R4=$(curl -fsS -X POST "$UP?name=FAILME.png" --data-binary 'y' \
  -H 'Content-Type: application/octet-stream' 2>/dev/null)
FPATH=$(echo "$R4" | grep -o '"path":"[^"]*"' | head -1 | sed 's/"path":"//;s/"//')
if echo "$R4" | grep -q '"ok":true' && echo "$R4" | grep -q '"notified":false' && [ -f "$FPATH" ]; then
  ok "upload notify graceful (notified:false, file saved)"
else
  bad "upload notify graceful ($R4)"
fi

# 6e. content-length cap enforcement (declared oversize -> 413).
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$UP?name=big.bin" \
  -H 'Content-Type: application/octet-stream' -H 'Content-Length: 999999999' \
  --data-binary 'x' 2>/dev/null)
[ "$CODE" = "413" ] && ok "upload cap enforced (413)" || bad "upload cap enforced (got $CODE)"

# 6f. CORS preflight for the Electron client (Origin file://).
CORS=$(curl -sS -D - -o /dev/null -X OPTIONS "$UP" -H 'Origin: file://' \
  -H 'Access-Control-Request-Method: POST' 2>/dev/null)
echo "$CORS" | grep -qi 'access-control-allow-origin: \*' && ok "upload CORS preflight" || bad "upload CORS preflight"

# 6g. herdr agent list is read-only and safe to exercise if herdr is present.
if command -v herdr >/dev/null 2>&1; then
  herdr agent list >/dev/null 2>&1 && ok "herdr agent list (read-only) reachable" || echo "NOTE: herdr agent list not reachable in sandbox"
fi
rm -rf "$DROPS"

echo "----"
echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
