# VERDICT — retire-tiamat claude-driver pass 3 (loopback B + ratelimit)

Date: 2026-08-20. Branch: sub/retire-tiamat-driver-jmrp.

## Commits (incremental, on top of inherited bcb9d8b)
- 6fcdaf5  loopback B (claude-facing gateway) + per-turn ratelimit capture
- 4ae0310  real two-loopback e2e harness + docs (loopback B built/verified)

## Deliverables
1. Loopback B — DONE. Extracted inherited inline handler into testable
   extensions/lib/loopback-b.ts (createClaudeFacingHandler). claude's
   ANTHROPIC_BASE_URL = http://127.0.0.1:<portB>/turn/<turnId>. Applies inherited
   applyCacheHygiene to POST /v1/messages body only; forwards to
   api.anthropic.com preserving claude's OWN auth/client headers (only
   host/content-length/connection/accept-encoding recomputed); streams upstream
   status/headers/body verbatim; clean teardown via session_shutdown. Added a
   413 request-size guard (32 MiB) as defense-in-depth.
2. Ratelimit capture — DONE. selectRatelimitHeaders picks
   anthropic-ratelimit-*/retry-after/request-id off the REAL upstream response;
   stored in ratelimitByTurn keyed by turnId (URL path) → no cross-turn race
   (entry deleted in finally); loopback A re-emits them on pi's response so the
   unchanged extensions/ratelimit.ts footer (after_provider_response) lights up.
3. Tests — 51 unit pass (was 42). New: loopback-b.test.ts (9: header
   preservation w/ FAKE auth, transformed body, verbatim streaming, 502 upstream
   error, 429/retry-after, ratelimit propagation, 413 guard, two-server
   isolation) + ratelimit-headers.test.ts (4, inherited).
4. Real e2e through BOTH loopbacks (host subscription creds, no token printed):
   e2e-loopback-b.test-harness.ts → PASS. text="PONG", stop_reason=end_turn ⇒
   claude's auth reached api.anthropic.com through loopback B. Cache HIT proven:
   cache_read_input_tokens=30823, cache_creation=2429. Ratelimit headers
   captured through B: unified-status=allowed, 5h util 0.32, 7d util 0.66,
   request-id present. Re-ran inherited harnesses through loopback B:
   e2e-multiturn-text (BANANA_7 recalled) PASS; e2e-tools (tool_use Paris →
   projected result consumed, no surviving claude proc) PASS.
5. Security audit — CLEAN. FAMILIAR_ANTHROPIC_OAUTH scrubbed from child env
   (claude-runner buildEnv drops it + all ANTHROPIC_*) and never in any log
   call; loopback B never logs body/headers (only turnId + counters). Both
   servers listen(0,"127.0.0.1") only; no 0.0.0.0. Cred file 0600, config dir
   0700. Request-size guard added.

## Remaining blockers / caveats (documented in CLAUDE-DRIVER.md)
- Images: still explicitly rejected (invalid_request_error) — NOT implemented
  (per instruction: only after everything else; deferred, correct).
- Session-seed stability: resume key derived from first user message text hash,
  not a pi conversation-id header. Stable within linear convo; first-message
  edit/compaction starts a fresh claude session (correctness preserved, that
  session's cache lost). Robust fix = pi conv-id header.
- Concurrency: same-conversation concurrent in-flight turns not stress-tested.
- Tool-turn text buffers (collapse mode) — no token streaming on tool turns.

## Safe to activate for a real Familiar restart?
YES for text + tools + multi-turn under FAMILIAR_ANTHROPIC_OAUTH (default no-op
without it — tiamat path untouched). Both loopbacks proven end-to-end with real
subscription creds; cache hits; ratelimit footer recovered; env-secret hygiene
verified. Do NOT send image content yet (hard-rejected by design).

## Key files
- extensions/lib/loopback-b.ts / .test.ts
- extensions/lib/ratelimit-headers.ts / .test.ts
- extensions/lib/e2e-loopback-b.test-harness.ts
- extensions/claude-driver.ts (loopback B wired via extracted handler)
- extensions/CLAUDE-DRIVER.md (status updated)
