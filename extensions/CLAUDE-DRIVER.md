# claude-driver — tiamat-retirement claude driver (pi extension)

Status as of 2026-08-20. Implements RESEARCH-retire-tiamat.md.

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

## What works end-to-end (VERIFIED)

- **v0 single-turn text chat**: `bun run extensions/lib/e2e-gateway.test-harness.ts`
  drives a real `claude -p` through loopback A and gets back a correct Anthropic
  SSE stream (`message_start → content_block_* → message_delta(usage) →
  message_stop`), assembled text `"PONG"`, `stop_reason: end_turn`, real usage.
- **Ephemeral-port isolation**: two gateways bind distinct ports; no collision.
- **ANTHROPIC_* env scrub**: verified the child is clean even when pi's tiamat
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` are present in the parent env.
- **Activation gate**: absent → returns `undefined`, zero provider calls.
  present → registers. Verified.
- **Credential materialization**: 0600 perms, exact host schema keys. Verified.
- **Projection (v1a)**: 9/9 ported Go tests pass, byte-determinism asserted.

Run all tests: `nix develop .#stt -c bun test extensions/lib/`

## What is STUBBED / not yet wired

- **Multi-turn projection wiring**: `claude-projection.ts` is complete and
  tested but not yet invoked by `claude-driver.ts` — v0 sends only the last
  user text as the stdin prompt. Wiring `--resume`/`--session-id` + writing
  `<config>/projects/<key>/<id>.jsonl` is the next step (v1b).
- **MCP stdio stub** (tools/list + tools/call turn-terminator): not built. v0
  is text-only.
- **Claude-facing gateway (loopback B)** + cache-breakpoint hygiene
  (`relocateClaudeContinuationCacheControl`, `relocateBreakpointsBeforeCut`,
  `stripClaudeContinuationArtifacts`): not built. v0 lets claude talk to
  `api.anthropic.com` directly via its host login in the ephemeral config dir —
  billing classification is already correct (subscription, not metered API).
- **Ratelimit footer** recovery from loopback B headers: pending loopback B.
- **Images**: parsed by the body parser but not yet projected (needs v1b wiring).

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
   plain model ids on `--model`.
