# Familiar Agent System

An independently deployable delegated-worker system. The SQLite service owns semantic jobs, one supervisor per host owns process reality, a private tmux server owns PTYs, and harness adapters own execution semantics. Familiar is only an API client.

## Quick start

```sh
go run ./cmd/familiar-agents-service --db /tmp/fa/service.db --unix /tmp/fa/service.sock --listen ''
go run ./cmd/familiar-agents-supervisor --service unix:///tmp/fa/service.sock --host laptop --state /tmp/fa/host
# in another shell (the built-in fake adapter needs only sh)
go run ./cmd/familiar-agents --service unix:///tmp/fa/service.sock dispatch --host laptop --harness fake --cwd "$PWD" 'exercise the worker lifecycle'
go run ./cmd/familiar-agents --service unix:///tmp/fa/service.sock list
```

Production workers require `tmux`. The supervisor creates a dedicated socket and complete minimal config (`allow-passthrough on` included); it never uses user/system tmux configuration. `attach-hint JOB` prints the same-host direct attach command. Closing that viewer never affects the worker.

Configuration is available as flags; service defaults can also use `FAMILIAR_AGENTS_DB`, `FAMILIAR_AGENTS_SOCKET`, and `FAMILIAR_AGENTS_LISTEN`; supervisor uses `FAMILIAR_AGENTS_ENDPOINT`, `FAMILIAR_AGENTS_HOST`, and `FAMILIAR_AGENTS_SUPERVISOR_STATE`.

## CLI

`dispatch`, `status`, `list [--state]`, `attach-hint`, `cancel`, `answer`, and `gc`. Global `--json` produces machine-readable output. Dispatch requires explicit `--host`; `--worktree` requests detached git-worktree isolation. `gc --root DIR --older-than DURATION` removes old per-job artifact directories.

## HTTP API

Both Unix-socket and loopback TCP listeners expose JSON:

- `POST /v1/jobs`, `GET /v1/jobs/{id}`, `GET /v1/jobs?state=`
- `POST /v1/jobs/{id}/cancel`, `POST /v1/jobs/{id}/answer`
- `POST /v1/hosts/{host}/poll` (desired assignments)
- `POST /v1/events` (idempotent observed batches)
- `GET /live`, `GET /ready`

See `protocol/README.md` and Go types for request/response schemas. TCP authentication is intentionally deferred; do not expose the listener beyond trusted loopback/tunneling.

## Recovery and authority

SQLite commits job/event/settlement changes transactionally. Duplicate creation, events, answers, progress, and settlement deliveries are idempotent. No terminal state is accepted without a settlement in the same durable transaction. Service outage does not kill or interrupt workers. The durable host registry re-adopts sessions after supervisor restart. On reboot it may recreate a missing worker only through its persisted, configurable offline restart deadline; an already-running worker survives service partitions. A private tmux-server loss is reported as an explicit failed-worker boundary. Process and harness observations determine status—viewer presence never does.

The service allocates a per-job artifact directory beside its database unless supplied by the caller. Worktrees live under that directory. Retention is caller-configured metadata and explicit GC; remote artifact portability is not implemented.

## Harness reality

The pi adapter launches real `pi --mode json --print --session ...`, persists JSON output/session data, parses lifecycle output as opaque progress, supports session resume, and delegates terminal input/cancel callbacks when available. Claude and Codex are minimal configurable argv adapters: transcript plus exit status only. They do **not** claim native steering, blocked-question, usage, or resume semantics. Tests use shell fakes and never require those binaries.
