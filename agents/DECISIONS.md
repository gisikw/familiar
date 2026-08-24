# Agent system decisions

1. **Kernel — SQLite-backed Go service.** A single static-friendly binary and
   transactional event/job updates match existing service conventions. The
   pure-Go `modernc.org/sqlite` driver avoids CGO deployment variance.
2. **Transport — Unix socket plus loopback HTTP JSON, with CLI wrapper.** Unix
   permissions are the local trust boundary. TCP is restricted to loopback.
   Authenticated network transport is explicitly deferred.
3. **Assignment — explicit host.** Dispatch requires a host, making ownership
   and partition behavior deterministic. Capability scheduling is future work.
4. **Offline policy — bounded per worker.** `offline_restart_window` is persisted
   as `restart_until`; workers already alive survive disconnection, while dead
   workers are recreated offline only before that deadline.
5. **Status — common lifecycle plus opaque detail.** The shared vocabulary is
   pending/assigned/starting/running/blocked/cancelling and terminal
   done/failed/cancelled/timeout. Harness-native evidence is opaque JSON.
6. **Terminal — direct private-tmux target.** Same-host users attach with the
   published socket and target. Authentication/proxy access is deferred.
7. **UI — out of scope.** HTTP JSON is the sole integration contract here.
8. **Artifacts/worktrees — logical global ID, bounded host-local directory.**
   The service assigns an opaque per-job artifact ID. The supervisor resolves it
   beneath its configured artifact root and accepts CWDs only beneath configured
   allowed roots. Optional worktrees live there; host-local `gc` removes settled
   artifacts older than policy. Portable artifact storage is future work.
9. **Pre-registration failure — durable bounded retry.** The local registry
   persists start attempts and exponential backoff. Transient tmux/filesystem or
   worktree failures exhaust a bounded budget; configuration/authorization
   failures settle immediately. In either case the attempt remains locally
   pending until the service durably commits the failed settlement.
10. **Pi projection/accounting — cursor plus schema.** A persisted side-channel
   byte cursor projects every complete documented lifecycle event once from the
   `agent-hooks` events.jsonl. Pi session usage fields are per-operation deltas;
   settlement reports their final cumulative sum from schema-defined top-level
   records, never recursive copies — used as the fallback when the extension
   does not report usage directly.
11. **Build — one `agents/flake.nix`.** All binaries share one Go module and lock,
   while separate flake packages preserve independently deployable outputs.
12. **Interactive TUI workers.** Workers run the harness's normal interactive
   TUI (pi: no `--mode json --print`; the prompt is pi's initial message). A
   human or the presence can attach writably and steer. An interactive harness
   owns the pane PTY, so no tee pipeline wraps it; its scrollback is the human
   record. Minimal argv harnesses keep the tee-to-file transcript.
13. **Side-channel lifecycle via hook adapters.** Because a TUI has no JSON
   stdout stream, each harness gets a sibling hook adapter that instruments it
   to append durable lifecycle records to a well-known append-only side-channel
   file (`Launch.Events`). For pi this is the `agent-hooks` extension
   (`--extension`), listening on pi's `agent_start`/`turn_end`/`agent_settled`
   events. `Observe` advances a durable cursor over that file. Crash detection
   stays with the supervisor (pane death → failed). This is the documented path
   for future harnesses (`harnesses/template.go`, `harnesses/README.md`).
   Blocked-question detection is an **explicit agent action**, not a stub: pi
   0.84.x exposes no native "ask the operator" mechanism (no AskUserQuestion),
   so the tool IS the mechanism. The agent-hooks extension registers an
   `agents_block` tool (params `question`, optional `options[]`); calling it
   appends a `{blocked,id,prompt,options,ts}` record to the side channel and
   returns a result telling the worker to end its turn and wait. The operator's
   answer arrives as the next TUI message (supervisor bracketed-paste
   send-keys). Event field names mirror `protocol.BlockedQuestion` exactly
   (`prompt`, not `question`; `ts`, not `at`) so `Observe` projects without
   translation; `options` was added to the protocol so the operator sees
   suggested answers. Resume is edge-triggered: `Observe` sets the question only
   on the tick that reads the blocked line, so the next observation returns the
   worker to Running once the answer resumes progress.
14. **Steering as keystrokes.** `SendText` types into the TUI via tmux
   `send-keys` with bracketed paste (so multi-line text is one atomic paste,
   not a turn per newline) then Enter. Cancel remains process-level.
15. **Writable worker sessions.** The viewer no longer attaches agent targets
   read-only (`-r` removed); workers are interactive by design.
16. **Settlement wakes the presence.** On any terminal state the supervisor
   promptly notifies the presence, best-effort. The primary transport is the
   worklist drop-box (the designed subagent-settlement channel per
   worklist/PROTOCOL.md): an atomic stable-id envelope in `incoming/`, drained
   and surfaced by the resident worklist extension per attention policy
   (failed/timeout → P1, done/cancelled → P2). A webhook transport covers
   cross-host supervisors. Configured via `FAMILIAR_AGENTS_WORKLIST_DIR` /
   `FAMILIAR_AGENTS_SETTLEMENT_WEBHOOK`; notification never fails or delays the
   durable settlement and is skipped-with-log when unconfigured. Chosen over a
   new gateway endpoint because the worklist is the repo's existing, tested
   inbound-notification machinery with idempotent drop-box semantics that match
   the supervisor's at-least-once redelivery.
17. **Worker tmux theming — cosmetic, non-blocking.** The supervisor composes
   the same `FAMILIAR_TMUX_THEME_CONFIG` artifact the presence uses (generated
   by `scripts/familiar-theme.sh` from the canonical palette) onto its private
   policy. Any missing/symlinked/unreadable artifact is skipped so workers
   still start on the plain policy. No hex is hardcoded.
18. **Worker profile isolation — a security/correctness boundary.** Each worker
   runs under a private per-job pi coding-agent dir (`<artifacts>/pi/`) the
   adapter writes at `Start`. `PI_CODING_AGENT_DIR` is set **explicitly** in the
   launch env (`launchEnv`) so the presence's personal profile can never leak
   through ambient supervisor env. The dir's `settings.json` enumerates **only**
   the worker extension set — `agent-hooks` (provides `agents_block`) plus the
   self-contained `web` extension (SSRF guard defaults to public-only) — and
   never the presence's worklist/identity/attention/zip/handoff/agents-dispatch/
   subscriber/telemetry suite. Consequences that motivate the boundary: workers
   cannot dispatch other workers, receive no presence inbox/orientation turn
   (the root cause of the observed "I'm ready to help" non-start — extension
   interference, not a swallowed positional prompt; proven by an isolated-profile
   run acting on the prompt on turn 0). **Per-job dir, not a shared template:**
   isolation is inherent (no concurrent Start races a shared mutable
   settings.json), it is removed with the job's artifacts, and it costs only a
   few small file writes. Extensions load via `settings.json`, **not** a CLI
   `--extension`, because pi errors if a tool (`agents_block`) is registered
   twice — one auditable file is the single source of the set (`pi_test.go`
   pins it). Native compaction is kept (the `compaction` key is omitted so pi's
   default applies; no custom handoff machinery). Model access parity: the
   presence's `models-store.json`, `defaultProvider`/`defaultModel`, and theme
   are copied from `FAMILIAR_AGENTS_PI_SOURCE_PROFILE` (default the supervisor's
   ambient `PI_CODING_AGENT_DIR`); only the model defaults are read from its
   settings, never its extension list. `job.Model` still overrides via `--model`.
   Credentials are **not** copied by default (they flow through ambient provider
   env like `ANTHROPIC_API_KEY`, keeping secrets out of per-job artifact dirs);
   `FAMILIAR_AGENTS_COPY_AUTH=1` opts into copying `auth.json`.
19. **tmux policy applied on every server-start path.** `tmux` reads a `-f`
   config **only** when the server is born. Sessions persist across supervisor
   restarts (`exit-empty off`, settled workers linger), so a supervisor that
   adopts a previously-started server would never apply a changed policy — the
   real-world defect where the worker showed `extended-keys off`, no mouse
   scroll, and no PageUp copy-mode. Fix: keep `-f cfg` at server birth, and
   additionally `source-file` the policy (a) after **every** session start and
   (b) at supervisor boot (`ReapplyPolicy`, a no-op when no server is running).
   `source-file` is idempotent (set-options/bindings) and applies synchronously
   to the live server. The synchronous post-start `source-file` also explains
   and eliminates the rare `TestPrivateTmuxLifecycle` "PageUp arbitration
   missing" flake: an immediate query could previously race the `-f` config's
   application at birth; the explicit `source-file` returns only once the policy
   is loaded. `-f` on a non-birth invocation is silently ignored by tmux
   (verified), so passing it on later starts is harmless but insufficient alone.
