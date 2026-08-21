# Familiar Server

Standalone, loopback-only supervisor for Familiar's local runtime services. It
implements one-for-one failure containment: a child exit only restarts that
child. Readiness dependencies gate start/readiness but never form a shared crash
boundary.

## Run

```sh
go run ./cmd/familiar-server --config ./server.toml
# From the repository root, the canonical Linux five-child deployment is:
./familiar.sh server
# (services/server/familiar-server.toml.example)
# FAMILIAR_SERVER_CONFIG and FAMILIAR_SERVER_LISTEN are equivalent env inputs.
```

`--config` is required. Relative `state_dir` and `working_dir` values resolve
against the config file directory. Commands are argv arrays and are never
interpreted by a shell. The configured listen address must be loopback.

`./familiar.sh server` first loads the validated `familiar.toml`/ambient
environment and enters the pinned pi shell for model defaults. Configured
`[llama]`, `[stt]`, and `[tts]` endpoints are bridged to the corresponding
proxy upstream variables; all consumers, including Presence, receive the stable
local proxy URLs. Without an upstream, LLM and STT model downloads are staged
atomically under `FAMILIAR_MODEL_DIR` before supervision starts. Existing files
are reused. TTS retains its proxy-owned lazy provisioning. The canonical config
includes Linux-only TTS and is therefore explicitly Linux-only; on Darwin use a
custom `FAMILIAR_SERVER_CONFIG` with a platform-appropriate child set.

## Configuration

Top-level keys:

| key | default | meaning |
|---|---|---|
| `listen` | `127.0.0.1:9940` | supervisor HTTP address |
| `state_dir` | `./state/server` | private child logs and runtime state |
| `shutdown_grace` | `10s` | SIGTERM grace before SIGKILL, per child |
| `read_header_timeout` | `5s` | HTTP header bound |
| `teardown_presence` | `false` | invoke Presence `stop_argv` on shutdown |
| `log_max_bytes` | 8 MiB | maximum bytes in each current child log |

Each `[[children]]` has `name`, non-empty `argv`, optional `working_dir`,
`env` string map, `required` (included in aggregate readiness), `depends_on`,
`dependency_timeout`, and `dependency_timeout_policy` (`fail-child`, the safe
default, or `start-degraded`). A timed-out `fail-child` remains gated and starts
automatically when dependencies recover. `start-degraded` launches the process,
but the child and aggregate readiness remain false until all dependencies are
ready. `presence=true` identifies the continuity boundary.
Presence must also be `detached=true`: its start command establishes the tmux
session and exits. `stop_argv` controls a detached service when explicitly
stopped or when full teardown is enabled.

`[children.probe]` supports `type = "none" | "http" | "exec"`, plus `url` or
`argv`, `interval` (default `1s`), `timeout` (default `2s`),
`success_threshold` (default `1`), and `failure_threshold` (default `0`, restart
disabled). Readiness requires consecutive successes. Once a running child's
configured consecutive-failure threshold is reached, detached controllers are
re-run and ordinary processes are terminated, then restarted through the same
bounded restart/backoff circuit as an exit. Exec probe output is discarded.
HTTP probe response bodies are drained only to 4096 bytes.

`[children.restart]` supports `policy = "always" | "on-failure" | "never"`,
`initial_backoff`, `max_backoff`, jitter in `[0,1]`, `max_restarts`, and
`window`. Exponential backoff has bounded jitter. More than `max_restarts`
within `window` opens that child's circuit and sets it to `failed`; operator
restart clears the circuit. A successful detached start remains supervised by
its readiness probe without treating the controller's zero exit as a crash.

Child stdout and stderr share `STATE_DIR/NAME.log`; rollover keeps one bounded
`NAME.log.1`. Child commands run in process groups. Stop is SIGTERM, bounded
grace, then SIGKILL. On Linux directly supervised children also receive a
parent-death signal. `Wait` is always called, so children are reaped.

## Endpoints

All responses are JSON except errors. There is no authentication; do not expose
the listener beyond loopback.

| endpoint | result |
|---|---|
| `GET /live` | process liveness |
| `GET /ready` | 200 iff every required child is ready; otherwise 503 |
| `GET /status` | aggregate readiness and per-child state, PID, restart count, last exit, readiness |
| `POST /children/{name}/restart` | clear circuit/manual stop and restart one child |
| `POST /children/{name}/stop` | stop one child without affecting siblings |

Shutdown proceeds in reverse dependency order (dependents before providers).
By default Presence is preserved and its stop command is not invoked. Set
`teardown_presence=true` only for intentional full teardown. Operator `stop`
always means an explicit stop, including for Presence.

## Five-child example

This full set is Linux-only because `familiar-tts` is Linux-only. The supervisor
binary and custom child sets remain supported on Darwin. The runnable source-tree example is [`familiar-server.toml.example`](familiar-server.toml.example). The deployment-path version below documents the equivalent installed layout. Paths are examples, not compiled defaults; replace them with deployment paths.
Gateway currently exposes `/health`, while the Go proxies expose `/ready`.

```toml
listen = "127.0.0.1:9940"
state_dir = "/var/lib/familiar/server"
shutdown_grace = "10s"
log_max_bytes = 8388608
teardown_presence = false

[[children]]
name = "llm"
argv = ["/opt/familiar/bin/familiar-llm"]
working_dir = "/var/lib/familiar"
required = true
[children.probe]
type = "http"
url = "http://127.0.0.1:9931/ready"
failure_threshold = 3
[children.restart]
policy = "on-failure"
initial_backoff = "500ms"
max_backoff = "30s"
jitter = 0.2
max_restarts = 5
window = "1m"

[[children]]
name = "stt"
argv = ["/opt/familiar/bin/familiar-stt"]
working_dir = "/var/lib/familiar"
required = false
[children.probe]
type = "http"
url = "http://127.0.0.1:9932/ready"
failure_threshold = 3

[[children]]
name = "tts"
argv = ["/opt/familiar/bin/familiar-tts"]
working_dir = "/var/lib/familiar"
required = false
[children.probe]
type = "http"
url = "http://127.0.0.1:9933/readyz"
failure_threshold = 3

[[children]]
name = "presence"
argv = ["/opt/familiar/services/presence/presence.sh", "ensure"]
stop_argv = ["/opt/familiar/services/presence/presence.sh", "stop"]
working_dir = "/opt/familiar"
presence = true
detached = true
required = true
depends_on = ["llm"]
dependency_timeout = "45s"
dependency_timeout_policy = "fail-child"
[children.probe]
type = "exec"
argv = ["/opt/familiar/services/presence/presence.sh", "status", "--quiet"]
interval = "1s"
timeout = "3s"
success_threshold = 3
failure_threshold = 3

[[children]]
name = "gateway"
argv = ["/opt/familiar/bin/bun", "run", "src/main.ts"]
working_dir = "/opt/familiar/services/gateway"
required = true
depends_on = ["presence", "stt", "tts"]
dependency_timeout = "30s"
dependency_timeout_policy = "fail-child"
[children.env]
FAMILIAR_PRESENCE_CTL = "/opt/familiar/services/presence/presence.sh"
FAMILIAR_STT_URL = "http://127.0.0.1:9932"
FAMILIAR_TTS_URL = "http://127.0.0.1:9933"
[children.probe]
type = "http"
url = "http://127.0.0.1:1692/health"
failure_threshold = 3
```

Omitted per-child probe and restart values receive the defaults documented
above. Unknown TOML keys, duplicate names, unknown dependencies, cycles,
invalid policies, and unbounded/invalid values fail startup.
