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
  as v0, plus 6 new v1b helper tests. 27 unit tests, all pass.

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

## What is STUBBED / not yet wired

- **Images**: parsed but NOT projected — the driver returns an explicit
  `invalid_request_error` ('refusing to silently drop pixels') rather than
  dropping them. Inline-base64 projection is a follow-up.
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
