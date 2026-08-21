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
8. **Artifacts/worktrees — per-job directory, optional worktree, configured
   retention.** The supervisor creates host-local job directories; the CLI `gc`
   removes settled artifacts older than policy. Portable artifact storage is
   future work.
9. **Build — one `agents/flake.nix`.** All binaries share one Go module and lock,
   while separate flake packages preserve independently deployable outputs.
