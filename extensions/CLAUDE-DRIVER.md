# claude-driver — tiamat-retirement claude driver (pi extension)

Status as of 2026-08-20. Implements architectural settlement from retired RESEARCH-retire-tiamat.md (archived in $FAMILIAR_ARTIFACT_DIR).

## What this is

A double-loopback gateway **owned by the pi extension**, in-process with pi,
that lets pi talk to Anthropic by driving the real `claude` CLI headlessly
(single-shot `claude -p` per turn) instead of routing through the tiamat Go
service. Extension-owned, stateless, ephemeral. NOT in `./server`.

## Files

| File | Role |
|------|------|
| `extensions/claude-driver.ts` | Extension entry. Activation gate, ephemeral pi-facing gateway, credential materialization, lifecycle. |
| `extensions/lib/anthropic-body.ts` | Anthropic Messages body → native `Message[]` (port of tiamat `anthropicTurnRequest`). |
| `extensions/lib/claude-runner.ts` | Spawn `claude -p`, translate stream-json → Anthropic SSE. ANTHROPIC_* env scrub. |
| `extensions/lib/claude-projection.ts` | **Byte-deterministic** TS port of tiamat `ProjectClaudeCodeJSONL` (v1a). Pure. |
| `extensions/lib/claude-projection.test.ts` | 9 tests ported from Go `claude_jsonl_test.go` — the projection spec. |
| `extensions/lib/anthropic-body.test.ts` | 13 tests: body parse, env scrub, argv. |
| `extensions/lib/e2e-gateway.test-harness.ts` | Standalone e2e: real claude through loopback A + port-isolation proof. |
| `extensions/lib/image-policy.ts` | Real Anthropic image caps + strict base64/dimension validation; actionable errors. |
| `extensions/lib/image-policy.test.ts` | 24 tests: valid PNG/JPEG, multiple, malformed/oversize, determinism, image tool_results. |
| `extensions/lib/e2e-images.test-harness.ts` | REAL e2e: direct user image + image tool_result continuation through both loopbacks. |

## How to ENABLE it

The extension is a **complete no-op** unless `FAMILIAR_ANTHROPIC_OAUTH` is set.
When absent, pi's existing tiamat path (`extensions/anthropic-gateway.ts`) is
entirely untouched.

1. Set the gate env var to your Anthropic subscription OAuth credential. Three
   accepted forms (auto-normalized to the CLI's `.credentials.json` schema):
   - Full envelope: `{"claudeAiOauth":{"accessToken":...,"refreshToken":...,"expiresAt":...,"scopes":[...],"subscriptionType":"max"}}`
   - Bare inner object: `{"accessToken":...,"refreshToken":...,...}`
   - Raw access token string (refresh/expiry defaulted).

   ```bash
   export FAMILIAR_ANTHROPIC_OAUTH="$(cat ~/.claude/.credentials.json)"
   ```

2. The extension is already listed in `familiar.sh`'s settings (`extensions: [ $REPO/extensions ]`),
   so it auto-loads. On boot (awaited factory) it:
   - creates an ephemeral temp root + `claude-config/` (mode 0700),
   - writes `<config>/.credentials.json` (mode 0600) from the gate value,
   - binds a loopback HTTP server on `127.0.0.1:0` (ephemeral port),
   - `pi.registerProvider("anthropic", { baseUrl: http://127.0.0.1:<port>/anthropic })`.

3. Optional: `FAMILIAR_CLAUDE_DRIVER_DEBUG=1` for stderr trace lines.

Teardown is automatic on `session_shutdown` (kills in-flight claude,
unregisters the provider — restoring tiamat behavior — closes the server, rms
the temp root).

## What works end-to-end (VERIFIED — v1b)

All harnesses drive the REAL `claude` CLI (2.1.197) with host subscription creds.

- **v0 single-turn text chat** (`e2e-gateway.test-harness.ts`): real `claude -p`
  through loopback A → correct Anthropic SSE, `"PONG"`, `end_turn`, real usage.
  Ephemeral-port isolation proven (two gateways, distinct ports).
- **v1b multi-turn TEXT resume** (`e2e-multiturn-text.test-harness.ts`): boots
  the actual driver extension; turn 1 establishes a codeword, turn 2 (fresh
  claude, `--resume` over the projected transcript) RECALLS it. One clean
  message per turn. PASS.
- **v1b tool round-trip** (`e2e-tools.test-harness.ts`): boots the driver;
  turn 1 → `tool_use(weather_now,{city:"Paris"})` with correct name/input/`toolu_*`
  id, `stop_reason: tool_use`, collapsed to ONE message; pi-side injects a
  `tool_result` marker; turn 2 → fresh claude consumes the projected result and
  returns final text containing the marker. **No claude process survives between
  turns** (asserted via pgrep). PASS.
- **ANTHROPIC_* + FAMILIAR_ANTHROPIC_OAUTH env scrub**: child env is clean even
  with pi's tiamat routing present; the OAuth secret never reaches the child.
- **Activation gate / credential materialization / projection determinism**:
  as v0, plus 6 new v1b helper tests, plus 24 image tests. 75 unit tests, all pass.

Run unit tests: `nix develop .#stt -c bun test extensions/lib/`
Run a real e2e (needs host `~/.claude/.credentials.json`):
`nix develop .#stt -c bun run extensions/lib/e2e-tools.test-harness.ts`

## Turn shape: verbatim vs collapse (IMPORTANT)

- **Text turns (no tools)** → VERBATIM mode: claude emits one message; the
  driver forwards `stream_event.event` frames straight through (token streaming).
- **Tool turns** → COLLAPSE mode: Claude Code 2.1.197 discovers MCP tools via an
  internal **ToolSearch** meta-tool, which emits EXTRA assistant messages
  (thinking + ToolSearch `tool_use`) before the real `mcp__pi__*` call. Pi needs
  exactly ONE Anthropic message per request, so the driver DRAINS claude's whole
  stream, keeps only user-facing text, reads the real tool call from the MCP
  stub's CAPTURE file, and synthesizes ONE clean message (`synthesizeCleanSSE`).
  Consequence: **tool-turn text does not stream token-by-token** (buffered into
  one block). Text turns still stream live.

## Loopback B (claude-facing gateway) — BUILT & VERIFIED

`extensions/lib/loopback-b.ts` (`createClaudeFacingHandler`) is claude's
`ANTHROPIC_BASE_URL` = `http://127.0.0.1:<portB>/turn/<turnId>`. Per request it:
1. recovers the per-turn id from the path,
2. applies cache/continuation wire hygiene (`applyCacheHygiene`) to the
   outbound `POST /v1/messages` body only (relocate CC onto the tool_result,
   strip the artifact tail; no-op path returns ORIGINAL bytes),
3. forwards to `api.anthropic.com` **preserving claude's own auth/client
   headers** (only host/content-length/connection/accept-encoding recomputed);
   no auth substitution, no capability spoof,
4. captures the upstream `anthropic-ratelimit-*` / `retry-after` / `request-id`
   headers for that turn (`selectRatelimitHeaders`) → `onRatelimit(turnId,…)`,
5. streams the upstream status/headers/body back verbatim,
6. 413 on oversized bodies (32 MiB default); 502 on unreachable upstream.

**Ratelimit footer RECOVERED.** The driver stores per-turn headers in
`ratelimitByTurn` (keyed by the turnId in the URL — no cross-turn race, entry
deleted in `finally`) and re-emits them on loopback A's response, so pi's
`after_provider_response` → `extensions/ratelimit.ts` footer lights up unchanged.

**Cache economics VERIFIED.** Real e2e through both loopbacks shows
`cache_read_input_tokens: 30823` (prompt-cache hit) — the hygiene keeps the
anchor on the stable prefix. E2E: `extensions/lib/e2e-loopback-b.test-harness.ts`.
Unit: `extensions/lib/loopback-b.test.ts` (9 tests) +
`extensions/lib/ratelimit-headers.test.ts` (4).

## Images — LIVE (inline base64, VERIFIED end-to-end)

Image blocks are supported end-to-end through fresh projected `claude -p` turns,
preserving media type and bytes. Both DIRECT user image blocks and
IMAGE-BEARING tool results (Familiar's read tool / uploaded screenshots) work.

**Representation chosen: inline base64.** A real-CLI probe of 2.1.197 settled
this empirically (`/tmp/imgprobe/probe-*.mjs` during development):
- inline base64 works via stdin stream-json AND in projected JSONL (both a
  prior-turn user image and an image-bearing `tool_result` with array content),
- a **local-file source** `{type:"file",path:...}` is REJECTED upstream —
  `"an image in the conversation could not be processed and was removed"`. So the
  RESEARCH §3.8 v2 "colocation" idea is NOT viable on 2.1.197; faithful inline
  base64 is the path.

Because base64 lives inline in the projected JSONL there are **no image temp
files** to leak and **no local paths** to perturb the deterministic cache
prefix — the colocation win's cleanup/determinism concerns simply don't arise.

**Caps (real Anthropic Messages API limits; `lib/image-policy.ts`), no tiamat
retention-window gating** (that gating only existed to bound a re-projected wire
payload — RESEARCH §3.8):
- media type ∈ {png, jpeg, gif, webp} (else actionable `invalid_request_error`),
- ≤ 5 MiB decoded per image, ≤ 100 images/request, ≤ 8000 px/side (dims parsed
  cheaply for png/jpeg/gif),
- strict base64 round-trip validation rejects truncated/garbage payloads.
Every violation throws an explicit, located `invalid_request_error`
(`messages[i].content[j] … / tool_result image[k]`) — **never silently drops
pixels**.

**Projection**: a `tool_result` carrying images projects to array content
(`[{text?},{image base64}…]`) with `toolUseResult.isImage:true`; a direct user
image projects to `{type:image,source:{type:base64,media_type,data}}`. A
trailing user message with images rides as a stream-json content array on stdin
(inline base64) rather than plain text.

**VERIFIED E2E** (`lib/e2e-images.test-harness.ts`, real claude 2.1.197 through
loopback A + `claude -p` + loopback B, tiny generated PNGs of known colors):
1. direct user GREEN image → claude replies `"green"`;
2. image-bearing tool_result continuation: turn 1 calls `screenshot`, we inject
   a PURPLE image tool_result, turn 2 (fresh claude, `--resume` over the
   projected transcript) reads it → `"vivid purple/violet"`;
3. unsupported media type → actionable error surfaced (never dropped).
Unit: `lib/image-policy.test.ts` (24 tests: valid PNG/JPEG, multiple images,
malformed/oversize/oversize-dims, count cap, deterministic projection, image
tool_results, body extraction). 75 unit tests pass total.

## What is STUBBED / not yet wired

- **Session-seed stability**: the resume key is derived from the first user
  message's text (`conv:<first 200 chars>`), NOT a pi-supplied conversation id.
  Stable within a linear conversation; a compaction/edit that changes the first
  user message would start a new claude session (correctness preserved — it just
  re-projects — but loses that session's cache). A pi conversation-id header
  would be the robust fix.
- **Concurrency**: turns within one instance share one CLAUDE_CONFIG_DIR; the
  per-conversation `<sessionId>.jsonl` is written fresh each turn and removed
  after. Distinct conversations use distinct session ids. Not yet stress-tested
  under concurrent in-flight turns on the same conversation.

## claude CLI stream-json surprises (for the next implementer)

1. **`--include-partial-messages` emits VERBATIM Anthropic SSE.** Each
   `{"type":"stream_event","event":{…}}` line's `.event` is already a
   well-formed Anthropic SSE frame (`message_start`, `content_block_delta` with
   `text_delta`/`input_json_delta`, `message_delta`, `message_stop`). The
   gateway forwards `.event` straight through — no text-delta re-synthesis. This
   collapses most of tiamat's `anthropicSSE` synth work. (Fallback path from the
   consolidated `assistant` line is retained for CLI versions without partials.)
2. **Inherited `ANTHROPIC_*` poisons the child.** With pi's tiamat
   `ANTHROPIC_BASE_URL=…/anthropic/managed` + `ANTHROPIC_API_KEY` inherited,
   `claude -p` routes there and 400s (`unsupported role "system"`). The runner
   strips every `ANTHROPIC_*` from the child env. Non-negotiable.
3. **`CLAUDE_CONFIG_DIR` + `.credentials.json` is sufficient auth.** A temp
   config dir containing only `.credentials.json` yields `apiKeySource:"none"`
   and authenticates on the subscription login — exactly what we want (no dummy
   cred, no capability header, correct billing). No need to touch the host
   `~/.claude`.
4. **The `result` line** (`{"type":"result",...}`) carries authoritative
   `usage` + `total_cost_usd` and marks turn end; used for teardown + fallback.
5. Model appears as e.g. `claude-opus-4-8[1m]` in output; the CLI accepts pi's
   plain model ids on `--model`. The driver adds the `[1m]` suffix only for the
   1M-context families (`claudeModelArg`).
6. **`--tools=` NO LONGER preserves MCP tools** (changed since tiamat's era).
   In 2.1.197 `--tools` controls only the BUILT-IN set; `--tools=` (empty)
   disables everything including MCP, so the pi tool never appears. Omit it and
   restrict with `--allowedTools=mcp__pi__*` instead. Built-in action tools
   (Bash/Read/Write…) are still spawned but are permission-BLOCKED by
   `--allowedTools` (verified: a `touch /tmp/PWNED` attempt was denied,
   `permission_denials` populated, no file created) — claude cannot execute
   tools locally, preserving pi's tool authority.
7. **MCP tool discovery goes through ToolSearch → multi-message turns.** See
   'collapse mode' above. This is the single biggest behavioral surprise.
8. **Project-key sanitization: EVERY non-alphanumeric char → `-`** (not just
   `/`). Verified by letting claude create a session and inspecting the
   `projects/` dir name: `/home/dev/.herdr/…` → `-home-dev--herdr-…` (note the
   double dash from the dot). Getting this wrong yields silent
   `No conversation found with session ID` and claude starts fresh (re-calling
   tools instead of consuming results). `claudeProjectKey` matches the CLI rule.
9. **MCP stub as turn terminator works cleanly.** The stdio stub returns a stub
   `tools/call` result then `SIGTERM`s its parent claude (30ms delay so the JSON
   response flushes). The full `tool_use` SSE is emitted BEFORE the kill, so the
   orchestrator has the real call; claude exits (exit 143). No held process.
