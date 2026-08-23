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
   Blocked-question detection is a stub: pi 0.84.x exposes no extension-visible
   "awaiting operator input" event; the schema reserves a `blocked` record.
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
