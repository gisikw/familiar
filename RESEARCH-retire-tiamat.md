# Retire tiamat's native-facade path → pi-extension-owned local claude driver

Date: 2026-08-20. Read-only research + design. Final architecture per Kevin:
a **double-loopback gateway owned by the pi extension**, in-process, driving a
single-shot `claude -p` per turn.

---

## 0. Final architecture (settled)

```
                 pi process (one per pi instance; subagents each run their own)
 ┌───────────────────────────────────────────────────────────────────────────┐
 │  pi core ──Anthropic Messages──►  PI-FACING GATEWAY  (loopback :Ppi)        │
 │    ▲                                   │  project transcript → <id>.jsonl    │
 │    │  synthesized SSE                  │  spawn claude -p (ONE turn)         │
 │    │  (text + tool_use)                ▼                                     │
 │    │                              claude -p  ──Anthropic Messages──►         │
 │    │                                   ANTHROPIC_BASE_URL = CLAUDE-FACING    │
 │    │                                   GATEWAY (loopback :Pcl)               │
 │    │                                        │ cache-breakpoint fix +         │
 │    │                                        │ continuation hygiene (on wire) │
 │    │                                        ▼                                │
 │    │                                   api.anthropic.com (claude's own auth) │
 │  MCP stub (loopback/stdio) ◄── claude tools/list, tools/call                 │
 │    └─ tool call ⇒ capture + terminate turn                                   │
 └───────────────────────────────────────────────────────────────────────────┘
```

Three loopback surfaces, all in the pi extension process, all ephemeral:
1. **Pi-facing gateway** — pi's `ANTHROPIC_BASE_URL`. Orchestrates one turn.
2. **Claude-facing gateway** — claude's `ANTHROPIC_BASE_URL`. Passthrough +
   cache/continuation hygiene, claude's auth intact. NOT a control surface.
3. **MCP stub** — claude's `--mcp-config` target. Exposes pi's tools; its only
   job is to capture a tool call and terminate the turn.

Claude's lifecycle is **single-turn, always**. No held process, no live resume,
no yielded control. Every pi request = one fresh projection + one `claude -p`.

---

## 1. What the facade does today (end to end)

Path today: `pi → tiamat /anthropic[/managed] → claude CLI → (claude's
ANTHROPIC_BASE_URL = tiamat gateway) → api.anthropic.com`, SSE back to pi.

### 1a. Inbound HTTP (`server/anthropic.go`)
- `POST /anthropic/v1/messages` (`handleAnthropicMessages`);
  `/anthropic/managed/...` sets `managed=true` and pre-strips continuation
  artifacts from the raw body (`StripContinuationArtifactsForFacade`).
- Session identity from headers: `X-Conversation-Id` → `anthropic:<conv>:<epoch>`;
  absent → `anthropic:oneshot:<reqid>`. `model` = router_profile (rename).
- `anthropicTurnRequest`: Anthropic → native `turn.Request`. Tool_results
  (inside Anthropic user messages) each become their own `role:"tool"` message
  emitted before trailing user text/image; system string|array → fragments;
  `tools[]` → `ToolDefinition`; image blocks (`anthropicImageBlock`).
- SSE synth (`streamAnthropicMessage`/`anthropicSSE`): `message_start` → live
  text deltas → trailing `tool_use` blocks (one `input_json_delta` each) →
  `message_delta`(stop_reason,usage) → `message_stop`. Headers deferred to first
  frame.

### 1b. Turn → claude (`turn/claude_code.go` `DispatchStream`)
Per request: temp root + `claude-config/` + **dummy** OAuth cred;
`projectedSessionID = SessionID(session_key)`;
`messagesForClaudeProjection` **drops the trailing user message** (it becomes the
stdin prompt); `rewriteToolNamesForClaudeProjection` → `mcp__tiamat__*`;
`continuationPrompt := last msg role=="tool"`.

`useResume := len(projectionMessages)>0` → `ProjectClaudeCodeJSONL` →
`writeProjectedClaudeSessionAt` writes `<config>/projects/<key>/<id>.jsonl`
(atomic rename, removed on defer). Then argv:
```
claude -p [--resume <id> | --session-id <id>] [--system-prompt-file f]
  --input-format stream-json --output-format stream-json
  --include-partial-messages --verbose --permission-mode default
  --settings s.json --tools= --strict-mcp-config --mcp-config m.json
  [--model <m[1m]>] [--allowedTools=mcp__tiamat__a,mcp__tiamat__b]
```
stdin = one stream-json user line: real last message content, OR the
`<tool-result>…</tool-result>` continuation string when resuming after a tool.
Env: scrub inherited ANTHROPIC_*, set `ANTHROPIC_BASE_URL=<tiamat gateway>`,
`ANTHROPIC_CUSTOM_HEADERS:<capability>`, `CLAUDE_CONFIG_DIR`, and
`CLAUDE_CODE_RESUME_PROMPT` when continuation.

Result shapes: (a) `tool_deferred` deferred_tool_use → `tool_call`; (b)
PostToolBatch stop → `toolCallContentFromClaudeOutput` → `tool_call`; (c) plain
completion → assistant message. Usage from `usageFromClaudeOutput`.

### 1c. Gateway (`turn/claude_gateway.go`)
Claude's upstream target. On `POST /v1/messages`: swap tool-result placeholders
(`replaceClaudeGatewayPlaceholders`), `relocateClaudeContinuationCacheControl`,
`stripClaudeContinuationArtifacts`, model pin, capture, proxy to Anthropic, 429
evidence + ratelimit-header logging, stream back.

### 1d. TWO facts that drive the new design

**Tool visibility — verified.** The gateway NEVER injects a `tools` array into
claude's outbound body (grep of `claude_gateway*.go` for tools injection: empty).
Claude learns pi's tools *only* from `--mcp-config` + `--allowedTools`; Claude
Code itself calls the MCP server's `tools/list` and populates the upstream
`tools` array. **⇒ The MCP stub is load-bearing for tool visibility and cannot
be dropped.** Tool *definitions* reach claude via the MCP stub's `tools/list`
(`mcpTools(inv.Tools)` — name/description/inputSchema), not via the projected
session and not via body injection.

**"Pause/resume" is not a held process — verified.** `native-paused` and
`native-post-tool-batch-paused` are **debug snapshots**
(`copyClaudeSessionFileDebug` copies the `.jsonl` to a temp debug dir); they are
NOT live suspended state. The actual stall mechanism:
- MCP stub, on `tools/call`, returns a stub text result AND sets the broker
  envelope `defer:true`; the perl shim then `kill TERM`s claude. OR
- the `PostToolBatch` hook returns `{"decision":"block"}`, stopping claude after
  the tool batch.
Either way **claude's `-p` process ends**. The gateway reads the tool_use from
claude's stdout and returns it to pi. Nothing is held between turns. Tiamat is
*already* single-shot-per-turn; the "resume" is only re-loading a freshly written
`.jsonl`, and `continuation_prompt` is just which stdin line to send. This
confirms the local design can be the simpler single-shot pattern with **no
snapshot/pause machinery at all**.

### Images today
Request image → native `image` block → `projectUserMessage` inline base64
(`{type:image, source:{base64,media_type,data}}`); url-only rejected. Live turn
image via stdin the same way. `applyImagePolicy` first: dim≤1568, ≤3.75MiB,
**ToolResultResolveLatest=1** (only newest tool-result keeps pixels; older →
text placeholders), MaxImagesPerResult 4, MaxMediaPerRequest 20. That retention
gating is the source of "outside retention window" / multi-image quirks — it
exists to bound the base64 payload crossing the wire and re-projected every turn.

---

## 2. pi extensibility — nothing beyond ANTHROPIC_BASE_URL

Confirmed. Pi already reaches tiamat purely via `ANTHROPIC_BASE_URL`;
`extensions/anthropic-gateway.ts` already does `pi.registerProvider("anthropic",
{ baseUrl })`. The new extension does the same, pointing at its own in-process
loopback. Verified lifecycle hooks in `docs/extensions.md`:
- **async factory is awaited before startup** (before `session_start`, before
  provider registrations flush) — so we can bind an ephemeral port and register
  the resolved `baseUrl` synchronously-enough for pi to use it.
- **`session_shutdown`** is the idempotent cleanup hook (fires on exit, switch,
  fork, clone). Close the loopback servers + kill any in-flight claude here.
- `ctx.shutdown()` emits `session_shutdown` before exit.

**Alternative considered (rejected):** a pi custom provider via `streamSimple`
(`docs/custom-provider.md`) could drive claude in-process and synthesize
`AssistantMessageEventStream` directly — no HTTP. Viable end-state, but couples
to pi-ai internal types/versioning. The loopback reuses the proven Anthropic-SSE
contract pi already speaks and stays language-agnostic. Loopback first.

---

## 3. The design

### 3.0 Ownership & isolation (NOT in ./server)
The familiar web server (`server/src`, :1692) stays unpolluted. The loopback is
**owned by the pi extension**, started in-process on pi boot, torn down on
`session_shutdown`. It is stateless (all state is the per-turn temp dir).

Extension file: `extensions/anthropic-gateway.ts` grows into (or spawns a sibling
`extensions/claude-driver.ts`) that:
1. On factory (awaited): create two `node:http` servers on **ephemeral ports**
   (`server.listen(0)` → read `server.address().port`). One for the pi-facing
   gateway, one for the claude-facing gateway. Optionally a third for the MCP
   stub (or stdio — see 3.4).
2. `pi.registerProvider("anthropic", { baseUrl: \`http://127.0.0.1:${Ppi}/anthropic\` })`.
3. Store `Pcl` (claude-facing) to inject as claude's `ANTHROPIC_BASE_URL` when
   spawning.
4. On `session_shutdown`: `server.close()` both, kill any live claude child,
   `pi.unregisterProvider("anthropic")` (restores prior behavior on reload).

**Isolation — multiple pi processes / dispatch subagents on one host:** ephemeral
ports (`listen(0)`) guarantee no collision; each pi instance owns its own trio,
bound to `127.0.0.1`, addressed only by that instance's registered `baseUrl` and
the child env it sets. Never bind a fixed port. Per-turn temp dirs
(`fs.mkdtemp`) and a per-instance `CLAUDE_CONFIG_DIR` under the temp root keep
projected sessions from colliding across instances and from polluting the user's
real `~/.claude/projects`.

### 3.1 Pi-facing gateway (orchestrator)
`POST /anthropic/v1/messages`:
1. Parse Anthropic body (port `anthropicTurnRequest` family: system, role-split
   tool_results→own messages, tools, image blocks). ~200 LoC, mechanical.
2. Project transcript minus trailing user msg → `<id>.jsonl` (port
   `ProjectClaudeCodeJSONL`; see 3.3). Trailing user msg / continuation string →
   stdin line.
3. Spawn `claude -p` (see 3.5) with claude's `ANTHROPIC_BASE_URL = Pcl`, MCP
   config pointing at the stub, `--allowedTools` for pi's tools.
4. Scan claude stdout stream-json → synthesize Anthropic SSE to pi (port
   `anthropicSSE`): live text deltas; on a tool call captured by the stub, emit
   the `tool_use` block(s) and end the turn.
5. Usage from claude's `result` line → Anthropic `usage`.

Single turn. Return to pi. Pi runs any tool; its NEXT request carries the
`tool_result`, which we project as a normal `tool_result` row → fresh `claude -p`.

### 3.2 Claude-facing gateway (passthrough + hygiene)
claude's `ANTHROPIC_BASE_URL`. `POST /v1/messages`:
- Forward upstream to `api.anthropic.com` with **claude's own headers/auth
  intact** (billing classification preserved — the request genuinely is Claude
  Code, host login). Do NOT substitute a dummy credential; do NOT add a
  capability header. This is the whole point: correct subscription billing, no
  $0-overage cap.
- On the wire, apply **cache-breakpoint fixing + continuation hygiene** — port
  `relocateClaudeContinuationCacheControl` + `relocateBreakpointsBeforeCut` +
  `stripClaudeContinuationArtifacts`. This is where those functions LIVE now
  (they don't die — see 3.6 correction). They make prompt caching survive across
  our per-turn fresh projections.
- Stream the response back to claude verbatim. Capture `anthropic-ratelimit-*`
  headers here (see §4 — this recovers the footer).
- No tool interception. Not a control surface.

### 3.3 Projection (the dense port)
Port `ProjectClaudeCodeJSONL` + `projectUserMessage`/`projectAssistantMessage`
faithfully: parentUuid chaining, deterministic UUIDs, assistant-content row
split, tool_use↔tool_result `sourceToolAssistantUUID` linkage, timestamp
monotonicity. ~400 LoC, pure. Keep the Go tests (`claude_jsonl_test.go`) as the
spec — port them to TS.

### 3.4 MCP stub (RETAINED, extension-owned)
Kevin's decision #1: **no yielding to a live claude, but the MCP stub stays** —
it's how pi's tools become *visible* to claude (verified: only path) and its job
is to *terminate the turn* on a tool call so pi keeps transcript authority.
- Lives in the extension: either a tiny `node:http` endpoint (claude's
  `mcp-config.json` names a stdio command that HTTP-bridges to it, as tiamat's
  perl shim does) OR — simpler in Node — a small **stdio MCP server script** the
  extension writes to the temp dir and names directly in `--mcp-config` (no
  HTTP hop, no perl). Prefer stdio: fewer moving parts, no extra port.
- Contract: `initialize` → tools capability; `tools/list` → pi's tool defs
  (name/description/inputSchema); `tools/call` → return a stub result and
  **signal turn-end** (write `{"decision":"block"}` via the PostToolBatch hook,
  or the defer/kill path). Claude's `-p` exits; orchestrator reads the tool_use
  from stdout and returns it to pi.
- **No placeholder-replacement dance.** Because the next turn re-projects pi's
  transcript (which now contains the real `tool_result`), claude reads the result
  from the fresh `.jsonl` — never from a gateway placeholder swap.
  `replaceClaudeGatewayPlaceholders` + the broker `Replacements` map DIE.

### 3.5 claude -p invocation (verified viable)
The per-turn pattern tiamat relies on is standard headless Claude Code
(confirmed via CLI docs + tiamat's argv). New invocation, per turn:
```
claude -p [--resume <id> | --session-id <id>]
  --input-format stream-json --output-format stream-json
  --include-partial-messages --verbose --permission-mode default
  --settings settings.json --strict-mcp-config --mcp-config mcp.json
  [--system-prompt-file sys.txt] [--model <m[1m]>]
  [--allowedTools=mcp__pi__<tool>,...]
env: ANTHROPIC_BASE_URL=http://127.0.0.1:<Pcl>
     CLAUDE_CONFIG_DIR=<temp>/claude-config
     (host ~/.claude login still used for the actual OAuth token — do NOT
      overwrite .credentials.json; claude reads the host login and sends it to
      our claude-facing gateway, which forwards it upstream)
```
- **Fresh session** (`--session-id`) when no prior transcript; **--resume <id>**
  when there is — both just load the `<id>.jsonl` we wrote this turn. Port
  `claudeCodeModelArg` for the `[1m]` window suffix.
- Auth note: unlike tiamat (which wrote a dummy cred because its gateway spoofed
  upstream), we WANT claude's real host login to flow through, so leave
  `CLAUDE_CONFIG_DIR`'s credentials from the host or don't override the cred file.
  Simplest: set `CLAUDE_CONFIG_DIR` only for the projected `projects/` dir but
  symlink/copy the host `.credentials.json`, or don't override the config dir at
  all and instead write the projected session into the host projects dir under a
  temp id (removed on defer). Decide during v1 spike; both work.

### 3.6 CORRECTION: does continuation stripping / cache fixing die?
Earlier draft said "dies entirely." **Partially wrong — refined:**
- **Continuation *stripping outbound to pi* dies.** We only read claude's
  assistant text/tool_use back to pi; we never copy claude's synthetic
  user/bridge turns into pi's context. And because WE author every byte of the
  projected `.jsonl` from pi's transcript, we never write artifact turns inbound
  either. So there is nothing to strip on pi's side. ✔ dies.
- **Cache-breakpoint fixing does NOT die — it moves to the claude-facing
  gateway.** Kevin's decision #3 is explicit and correct: fresh-projection-
  per-turn means claude issues a full-context request each turn; without
  breakpoint hygiene on that request, prompt caching won't hit and we re-bill the
  whole context every turn. The claude-facing gateway keeps
  `relocateClaudeContinuationCacheControl` + `relocateBreakpointsBeforeCut` +
  `stripClaudeContinuationArtifacts` **on claude's outbound wire** so the
  prompt-cache anchor lands on the stable prefix and Anthropic's max-4-breakpoint
  constraint holds. So the stripping code survives — as *upstream wire hygiene*,
  not as pi-context cleanup.

### 3.7 Cache economics of fresh-projection-per-turn (Kevin's Q1)
- **Claude Code's normal prompt caching is prefix-based:** it marks cache
  breakpoints near the end of the stable prefix (system + prior transcript). As
  long as our per-turn projection reproduces the **same prefix bytes** in the
  same order (deterministic UUIDs/timestamps in the projection make this true —
  that's why the Go projector is deterministic), turn N+1's request shares the
  cached prefix of turn N. Cache **read** (0.1×) instead of fresh **write**
  (1.25×) for the whole prior context.
- The risk fresh-projection introduces: if the projected prefix shifts by even
  one byte (a moved breakpoint, an artifact turn, a re-ordered block), the cache
  misses and the full context re-bills — exactly the 429/rebill tiamat fought.
  The claude-facing gateway's breakpoint fixing is what keeps the anchor on the
  stable prefix so the cache hits. **⇒ fresh-projection is cache-viable IFF the
  claude-facing hygiene is correct and the projection is byte-deterministic.**
  Both are portable from tiamat's tested Go.
- Net: recovered cost ≈ same as tiamat today (which also re-projects every turn).
  We are not regressing; we're relocating the same hygiene next to the process.

### 3.8 Images: the colocation win
- v0/v1: inline base64 in the projected `.jsonl`, **retention gating dropped**
  (`ToolResultResolveLatest=1` was there to bound the wire payload; local disk
  has no such pressure). Keep only Anthropic's real per-image caps (5MB / dim).
  This alone kills the multi-image / "outside retention window" quirks.
- v2: image block → local temp file (`<tmp>/img-<hash>.<ext>`) → filesystem
  reference. Colocation means the file the request describes and the process that
  reads it share a disk — no base64 across any wire, no accumulation in resumed
  sessions, each image independently addressable. Claude Code reads local image
  files in print/session mode.

---

## 4. Honest costs — what else tiamat does; where it goes

- **Usage/cost telemetry.** Per-turn usage comes from claude's stream-json
  `result` line → synthesized into pi's Anthropic `usage` block (unchanged UX).
- **Ratelimit footer (`extensions/ratelimit.ts`) — RECOVERED (correction to my
  earlier draft).** Because the **claude-facing gateway sees real
  api.anthropic.com responses**, it can read `anthropic-ratelimit-*` /
  `retry-after` headers off claude's upstream call. The extension can surface
  them to pi's footer directly (it's in-process — set a status line, or feed the
  existing ratelimit snapshot file). So the footer does NOT go dark. This is a
  concrete win of the double-gateway over a single pi-facing loopback.
- **Capture/replay diagnostics.** Port narrowly: dump each projected `.jsonl` +
  claude stdout to a debug dir (tiamat's `copyProjectedClaudeSessionDebug`).
  Skip the gateway capture/replay/entitlement scaffolding.
- **Model routing/steering (lordhenry manifest).** Honor `model` field →
  `claude --model` (+`[1m]` suffix). Multi-arm routing is a tiamat feature that
  doesn't apply to a single-backend claude driver; keep tiamat for that if Kevin
  still wants it, or add a tiny model map to the extension.
- **429 machinery.** Largely moot: real Claude Code handles its own rate limits
  and surfaces them in stream-json; no $0-overage bounce (not on the metered
  raw-API classification). The claude-facing gateway can still log/capture a 429
  for evidence cheaply.
- **Multi-consumer gateway for other clients.** If anything but pi points at
  tiamat's `/anthropic`, retiring that path breaks them — audit first. The
  loopback is pi-instance-scoped by design.

### What should NOT move
- Tiamat's entitlements/wings/multi-consumer control plane (tiamat's reason to
  exist for *other* consumers).
- Placeholder-replacement + broker Replacements map → DIE, don't move.
- Pi-context continuation stripping → DIES (we author the transcript).
- Cache/breakpoint hygiene → MOVES to the claude-facing gateway (does not die).

### Effort / risk
- Port: projection ~400 LoC (dense, pure, Go tests as spec); pi-facing parse+SSE
  +lifecycle ~500 LoC; claude-facing passthrough+hygiene ~250 LoC; MCP stdio stub
  ~120 LoC. ~1300 LoC TS + ported tests. **v0 a few days; v1 ~1–2 weeks.**
- Risk **medium**, concentrated in: (1) byte-deterministic JSONL projection
  (wrong parentUuid/tool linkage → claude rejects/mis-resumes; wrong prefix bytes
  → cache miss → cost blowup); (2) claude-CLI stream-json format drift (pin +
  behavior-test the CLI version); (3) MCP stub turn-termination contract
  (PostToolBatch/defer) tracking CLI changes. Migration risk low: one env var
  flips pi back to tiamat instantly.

---

## 5. Staged plan

**v0 spike (~1–2 days) — one simple turn, no tools, no images, no claude-facing
gateway yet.**
- In `extensions/claude-driver.ts`: on the awaited factory, start ONE `node:http`
  loopback on an ephemeral port; `pi.registerProvider("anthropic", { baseUrl })`.
- Handler `POST /anthropic/v1/messages`: parse body, take last user text, spawn
  `claude -p --output-format stream-json --include-partial-messages "<text>"`
  using the **host login** (no CLAUDE_CONFIG_DIR override, no gateway, no MCP).
- Scan stdout stream-json → synthesize Anthropic SSE (message_start → text deltas
  → message_delta w/ usage from `result` → message_stop).
- `session_shutdown`: close server, `unregisterProvider`, kill child.
- Success = pi holds a normal single-turn text chat via local claude, correct
  subscription billing, zero tiamat. Ephemeral port proven not to collide with a
  second concurrent pi.

**v1 (~1–2 weeks) — multi-turn + tools + images + claude-facing gateway.**
- Add the **claude-facing gateway** (second ephemeral loopback); set claude's
  `ANTHROPIC_BASE_URL` to it; port cache/continuation hygiene onto that wire;
  capture ratelimit headers → footer.
- Port `ProjectClaudeCodeJSONL` faithfully (Go tests → TS); write `<id>.jsonl`
  under a per-instance temp `CLAUDE_CONFIG_DIR`; `--resume` per conversation id;
  continuation-prompt stdin line for tool-result resumes.
- Add the **MCP stdio stub** in `--mcp-config`; `tools/list` = pi's tools;
  `tools/call` = stub result + turn-terminate (PostToolBatch block). Orchestrator
  surfaces the tool_use to pi; pi runs it; next request re-projects with the
  result. No placeholder swap.
- Images inline base64, retention gating removed.

**v2 (retire the gateway path).**
- Image blocks → local temp files handed to claude (full colocation).
- Confirm ratelimit footer fed from claude-facing gateway headers.
- Audit other tiamat `/anthropic` consumers; delete tiamat's facade, gateway,
  stripping-for-pi, placeholder, capability/entitlement-on-this-path code.
- Keep tiamat only for any genuine multi-consumer / control-plane role.
