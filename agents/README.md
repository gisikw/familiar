# Familiar Agent System

An independently deployable delegated-worker system. The SQLite service owns semantic jobs, one supervisor per host owns process reality, a private tmux server owns PTYs, and harness adapters own execution semantics. Familiar is only an API client.

## Quick start

```sh
go run ./cmd/familiar-agents-service --db /tmp/fa/service.db --unix /tmp/fa/service.sock --listen ''
go run ./cmd/familiar-agents-supervisor --service unix:///tmp/fa/service.sock --host laptop --state /tmp/fa/host --artifact-root /tmp/fa/host/artifacts --allowed-cwd-roots "$HOME"
# in another shell (the built-in fake adapter needs only sh)
go run ./cmd/familiar-agents --service unix:///tmp/fa/service.sock dispatch --host laptop --harness fake --cwd "$PWD" 'exercise the worker lifecycle'
go run ./cmd/familiar-agents --service unix:///tmp/fa/service.sock list
```

Production workers require `tmux` and `bash`. The supervisor creates a dedicated socket and complete minimal config (`allow-passthrough on` included); it never uses user/system tmux configuration. Harness output passes through `tee` so it remains visible in the worker pane while being appended byte-for-byte to the observation transcript; Bash `pipefail` preserves harness exit status. `attach-hint JOB` prints the same-host direct attach command. Closing that viewer never affects the worker.

Configuration is available as flags; service defaults can also use `FAMILIAR_AGENTS_DB`, `FAMILIAR_AGENTS_SOCKET`, and `FAMILIAR_AGENTS_LISTEN`; supervisor uses `FAMILIAR_AGENTS_ENDPOINT`, `FAMILIAR_AGENTS_HOST`, `FAMILIAR_AGENTS_SUPERVISOR_STATE`, `FAMILIAR_AGENTS_ARTIFACT_ROOT`, `FAMILIAR_AGENTS_ALLOWED_CWD_ROOTS` (OS path-list-separated), and `FAMILIAR_AGENTS_LINGER_SECONDS` (default 3600). The artifact root defaults beneath supervisor state and allowed CWD roots default to the user's home.

## CLI

`dispatch`, `status`, `list [--state]`, `attach-hint`, `cancel`, `reap`, `answer`, and `gc`. `reap JOB` requests immediate removal of a settled job's lingering worker session; active jobs are refused. Global `--json` produces machine-readable output. Dispatch requires explicit `--host`; `--worktree` requests detached git-worktree isolation. `gc --root DIR --older-than DURATION` removes old per-job artifact directories.

## HTTP API

Both Unix-socket and loopback TCP listeners expose JSON:

- `POST /v1/jobs`, `GET /v1/jobs/{id}`, `GET /v1/jobs?state=`
- `POST /v1/jobs/{id}/cancel`, `POST /v1/jobs/{id}/reap`, `POST /v1/jobs/{id}/answer`
- `POST /v1/hosts/{host}/poll` (desired assignments)
- `POST /v1/events` (idempotent observed batches)
- `GET /live`, `GET /ready`

See `protocol/README.md` and Go types for request/response schemas. TCP authentication is intentionally deferred; do not expose the listener beyond trusted loopback/tunneling.

## Recovery and authority

SQLite commits job/event/settlement changes transactionally. Duplicate creation, events, answers, progress, and settlement deliveries are idempotent. No terminal state is accepted without a settlement in the same durable transaction. Service outage does not kill or interrupt workers. The durable host registry re-adopts sessions after supervisor restart. On reboot it may recreate a missing worker only through its persisted, configurable offline restart deadline; an already-running worker survives service partitions. A private tmux-server loss is reported as an explicit failed-worker boundary. Process and harness observations determine status—viewer presence never does. After settlement the supervisor retains the worker tmux session and scrollback for one hour by default, reaping lazily on reconciliation after the linger deadline or when the durable reap endpoint is requested.

The service assigns only a logical artifact ID. Each supervisor resolves that ID beneath its configured host-local artifact root; callers cannot supply filesystem artifact paths. Supervisors reject CWDs outside configured allowed roots. Worktrees live under the resolved job directory. Retention is caller-configured metadata and explicit host-local GC; remote artifact portability is not implemented. Pre-registration failures use durable local attempt/backoff state, then publish a failed settlement after a bounded retry budget; configuration errors such as unknown harnesses or unauthorized CWDs settle immediately.

## Harness reality

The pi adapter launches real `pi --mode json --print --session ...`, persists JSON output/session data, projects documented lifecycle records using a durable byte cursor, supports session resume, and delegates terminal input/cancel callbacks when available. Settlement usage is the final cumulative sum of schema-defined per-operation session usage records; nested copies are ignored. Claude and Codex are minimal configurable argv adapters: transcript plus exit status only. They do **not** claim native steering, blocked-question, usage, or resume semantics. Tests use shell fakes and never require those binaries.
