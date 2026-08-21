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

The default endpoint is `http://127.0.0.1:9931`. `GET /live` reports proxy
liveness. `GET /ready` validates that the proxy can accept work and
returns JSON with backend state (`upstream`, `cold`, `starting`, or `running`).
A cold local service is ready: static executable/model prerequisites are checked
at process construction, and actual startup remains lazy. Readiness never starts
the backend, so supervisor readiness gates cannot deadlock first traffic.

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
| `FAMILIAR_LLM_READ_HEADER_TIMEOUT` | `10s` | Client request-header deadline |
| `FAMILIAR_LLM_BODY_TIMEOUT` | `30s` | Client request-body deadline, before inference starts |
| `FAMILIAR_LLM_SHUTDOWN_TIMEOUT` | `10s` | Graceful shutdown deadline |
| `FAMILIAR_LLM_DEBUG_CHILD` | `false` | Log redacted child stderr tail on abnormal exit |
| `FAMILIAR_LLM_DIAGNOSTIC_BYTES` | `16384` | Stderr tail bytes; hard-capped at 65536 |

Local invocation preserves Familiar's previous llama router flags:
`--models-dir`, `--jinja`, loopback host, `-ngl 999`, and `-c 32768`.
The service deliberately does **not** download models. Provision
`$FAMILIAR_MODEL_DIR/$FAMILIAR_MODEL_FILE` as explicit mutable runtime state
(outside the Nix store), using a temporary file plus atomic rename.

The reverse proxy strips hop-by-hop headers, streams with immediate flushing and
backpressure through Go's HTTP stack, limits request bodies, and bounds client
reads and backend response-header waits. Logs omit URLs, queries, headers,
bodies, upstream addresses, and child command lines. Child stdout is discarded;
stderr has strictly bounded retention and is emitted only under explicit debug,
after bearer/token/password/URL-credential redaction. Responses stay generic.

On SIGINT/SIGTERM the proxy drains HTTP and sends SIGTERM to the local child's
process group, escalating when the shutdown deadline expires. Linux additionally
sets `Pdeathsig=SIGKILL`, preventing an orphan after abrupt proxy death. Other
Unix platforms retain process-group cleanup for ordinary shutdown, but kernel
parent-death cleanup is unavailable: proxy SIGKILL may leave the backend for an
external supervisor to reap. Non-Unix platforms use the platform process API.
Upstream and local-backend endpoints that normalize to the proxy's own loopback
listen endpoint are rejected.

This standalone service is available under the MIT License; see `LICENSE`.
