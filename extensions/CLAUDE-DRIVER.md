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

The extension is a **complete no-op** unless one explicit credential form is
set. When absent, pi's existing tiamat path (`extensions/anthropic-gateway.ts`)
is entirely untouched.

1. Prefer private `familiar.toml` configuration (mode 0600). Choose exactly one:
   - `[anthropic] claude_credentials_json` containing the full renewable
     `.credentials.json` envelope (or its inner OAuth object); or
   - `[anthropic] claude_oauth_token` containing `claude setup-token` output.

   The old `FAMILIAR_ANTHROPIC_OAUTH` env setting remains JSON-only compatibility.
   There is deliberately no raw-secret shape guessing. See `docs/CONFIG.md` for
   validation and manual cutover steps.

2. The extension is already listed in `familiar.sh`'s settings (`extensions: [ $REPO/extensions ]`),
   so it auto-loads. On boot (awaited factory) it:
   - creates an ephemeral temp root + `claude-config/` (mode 0700),
   - either writes renewable JSON to `<config>/.credentials.json` (mode 0600)
     or supplies the direct token as `CLAUDE_CODE_OAUTH_TOKEN` to Claude Code,
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
- **Credential env scrub**: inherited provider and Familiar source variables
  are removed. Only the explicitly selected direct token is supplied to Claude
  Code as its documented `CLAUDE_CODE_OAUTH_TOKEN`; JSON remains file-only.
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

**History policy (empirically re-checked against Claude Code 2.1.197): retain
images verbatim until ordinary compaction.** A generated-fixture, zero-cost
headless `--resume` probe captured the body at a local fake Anthropic upstream.
Claude Code sent historical direct-user images, historical image-bearing tool
results, and three direct images across three prior turns unchanged. It also
sent all twelve image-bearing `Read` results whose older generated text exceeded
the microcompaction savings threshold. Thus there is no independent image-age window
to copy into the Familiar projection.

The nearby Claude Code microcompaction is tool-result policy, not a general
historical-image filter. In 2.1.197's bundled source it can replace eligible old
tool results wholesale with `[Old tool result content cleared]`, keeps the five
most recent eligible tool calls, and requires an estimated 20,000 tokens saved.
Its first-party `context_hint` path is feature/server-negotiated, so its exact
activation and cache effect are version-sensitive; the fake-upstream probe did
not negotiate it. Explicit `/compact`/autocompaction naturally changes the
transcript to a summary, after which old images are no longer present to
project. Pi remains the transcript authority: Familiar does not mutate pi's
history or invent a Claude-only summary.

**Ingestion preprocessing and synthetic-resume parity.** A second generated
Retina-like fixture probe found an important boundary: ordinary Claude Code
images are preprocessed at ingestion, while image bytes loaded from synthetic
`--resume` JSONL bypass that pass. Current stream-json and ordinary `@path`
ingestion behaved identically. In 2.1.197 the ingestion pipeline:

- leaves an image byte-identical only when it is both ≤2000px/side and ≤500 KiB;
- scales larger dimensions to about 2000px preserving aspect ratio;
- uses a staged 3.75 MiB resize/re-encode pass (same-family PNG and JPEG
  qualities 80/60/40/20, with a 1000px quality-20 fallback), then a separate
  JPEG quality search for the final budget;
- enforces a final 512,000-byte budget (observed outputs 56–509 KiB);
- converts high-entropy PNG/JPEG/WebP Retina fixtures to JPEG;
- strips EXIF/ICC/orientation metadata whenever it transforms an image.

Examples: a generated 3024×1964 screenshot PNG went 168,661-byte PNG →
79,381-byte 1999×1298 PNG; high-entropy Retina PNG/JPEG/WebP inputs of
17,850,996/12,012,566/5,943,466 bytes became 429–431 KiB 1999×1298 JPEGs.
A 408,914-byte 1999×1200 JPEG was byte/hash/metadata identical; a 3,941,958-byte
one became a 509,161-byte JPEG. Three and 21 Retina screenshot inputs were each
processed independently and produced 345,498-byte and 2,254,511-byte complete
requests. More than 20 does not trigger a different client transform: the
client already uses 2000px; the separate `many-image` rule is API-side.

Synthetic resume history diverged before this fix: a small compressible Retina
PNG was replayed byte-identically at 3024×1964, and under-5-MiB JPEG/WebP
fixtures were replayed byte-identically with metadata. Images whose **base64**
exceeded Claude's 5 MiB preflight limit failed before any upstream request.

Familiar now preprocesses only the projection copy of historical direct-user
and tool-result images (`lib/claude-image-preprocess.ts`), retaining pi's exact
transcript as authority. It uses pinned `ffmpeg`, max 2000px/512,000 bytes,
original-family-first then bounded JPEG fallback, strips metadata, caches at
most 64 transformed results (~31.25 MiB), and errors explicitly on failure.
The trailing direct-user image is left for Claude's native ingestion path, so
its exact encoder and original/display-dimension annotation remain intact.
Familiar's historical encoder is deterministic but is not claimed byte-for-byte
identical to Claude's private Sharp/native encoder; its dimensions, format
fallback, and byte bound match the observable policy.

**Caps and bounded growth** (`lib/image-policy.ts`):
- media type ∈ {png, jpeg, gif, webp} (else actionable `invalid_request_error`),
- projected historical images ≤512,000 bytes and ≤2000px/side,
- a trailing current source may be up to 32 MiB so Claude can preprocess it;
  malformed base64, unsupported type, or >8000px still errors locally,
- ≤100 images/request; loopback B caps the complete outbound body at 32 MiB.

The aggregate cap counts current/historical and direct/tool-result images.
2.1.197 sends 100 but silently reduces 101 to 80; Familiar rejects 101
explicitly. At worst-case 512,000-byte historical outputs the 32 MiB body cap
binds first at roughly 49 images (base64 overhead included); typical generated
Retina screenshots in the probe were ~79 KiB each, so the 100-image count cap
binds first. Every malformed/count/preprocessing violation is a located error —
**never silent current-image loss**.

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
Unit: `lib/image-policy.test.ts` covers valid PNG/JPEG, multiple and historical
images, malformed/oversize/oversize-dims, aggregate count cap, deterministic
projection, image tool_results, and body extraction. The safe probe and results
are retained in the dispatched investigation artifact directory.

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
