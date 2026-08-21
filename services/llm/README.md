# Familiar LLM service

A stable OpenAI-compatible, loopback-only HTTP proxy. It forwards every path
(including llama.cpp `/v1/chat/completions`, `/v1/completions`, `/v1/models`,
and embeddings paths) unchanged. With an upstream configured it never starts a
local process. Without one, the first non-health request starts `llama-server`;
a later request starts a fresh backend if it crashes. Requests are never
retried.

## Run

```sh
nix run .#                         # from this directory
# or
go run ./cmd/familiar-llm
```

The default endpoint is `http://127.0.0.1:9931`. `GET /live` (and compatibility
alias `/health`) reports proxy liveness. `GET /ready` is 204 when a configured
upstream is selected, or when the lazy local child is currently ready; it does
not trigger startup.

## Configuration

Environment variables are the complete configuration contract:

| Variable | Default | Meaning |
|---|---:|---|
| `FAMILIAR_LLM_LISTEN` | `127.0.0.1:9931` | Proxy listen address; non-loopback values are rejected |
| `FAMILIAR_LLM_UPSTREAM` | unset | HTTP(S) upstream base URL |
| `FAMILIAR_LLM_BACKEND` | `127.0.0.1:9934` | Private local llama-server address |
| `FAMILIAR_LLAMA_SERVER` | `llama-server` | Local executable |
| `FAMILIAR_MODEL_DIR` | `models` | Runtime model/router directory |
| `FAMILIAR_MODEL_FILE` | required locally | Model that must already exist in the directory |
| `FAMILIAR_LLM_CONTEXT` | `32768` | llama.cpp context (`-c`) |
| `FAMILIAR_LLM_GPU_LAYERS` | `999` | llama.cpp GPU layers (`-ngl`) |
| `FAMILIAR_LLM_MAX_BODY_BYTES` | `33554432` | Request body bound |
| `FAMILIAR_LLM_STARTUP_TIMEOUT` | `2m` | Child health deadline |
| `FAMILIAR_LLM_HEADER_TIMEOUT` | `2m` | Backend response-header deadline (stream bodies remain unbounded) |
| `FAMILIAR_LLM_SHUTDOWN_TIMEOUT` | `10s` | Graceful shutdown deadline |

`LLAMA_BASE_URL` is intentionally not read: it is the consumer-facing stable
proxy URL in existing Familiar configurations, so treating it as an upstream
could create a proxy loop. Supervisors should publish the listen URL there for
consumers and map `[llama].base_url` to `FAMILIAR_LLM_UPSTREAM` separately.

Local invocation preserves Familiar's previous llama router flags:
`--models-dir`, `--jinja`, loopback host, `-ngl 999`, and `-c 32768`.
The service deliberately does **not** download models. Provision
`$FAMILIAR_MODEL_DIR/$FAMILIAR_MODEL_FILE` as explicit mutable runtime state
(outside the Nix store), using a temporary file plus atomic rename.

The reverse proxy strips hop-by-hop headers, streams with immediate flushing and
backpressure through Go's HTTP stack, limits request bodies, and bounds backend
response-header waits. Logs do not include URLs, query strings, headers, bodies,
upstream addresses, or child command lines, to avoid leaking credentials.
On SIGINT/SIGTERM the proxy drains HTTP and sends SIGTERM to the local child's
process group, escalating when the shutdown deadline expires.
