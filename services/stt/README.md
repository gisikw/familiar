# Familiar STT

A loopback-only, stable OpenAI-compatible speech-to-text boundary. It exposes
`POST /v1/audio/transcriptions`, accepting either a raw audio body or a
`multipart/form-data` body whose `file` part contains audio, and returns
`{"text":"..."}`.

With `STT_UPSTREAM_URL`, the request body and end-to-end headers are streamed
once to `<upstream>/v1/audio/transcriptions` (no transcription retries). Without
it, the first request single-flight initializes the local toolchain. Each local
request is written to a private temporary directory, normalized by ffmpeg to
16 kHz mono WAV, and passed to `transcribe-cli`; all files are removed afterward.

## Run

```sh
nix run . --impure                    # from services/stt
# or
STT_MODEL=$HOME/.local/share/familiar/models/parakeet.gguf familiar-stt
```

The model is deliberately runtime state, not a Nix output. Download it outside
the store and atomically rename a completed `.part` file into place. This
service does not download models or log request headers/bodies/upstream URLs.

## Contract

| Environment | Default | Meaning |
|---|---:|---|
| `STT_LISTEN` | `127.0.0.1:9932` | listen address (loopback by default) |
| `STT_UPSTREAM_URL` | unset | HTTP(S) upstream base URL |
| `STT_MODEL` | required locally | local `.gguf` path |
| `STT_FFMPEG` | `ffmpeg` | ffmpeg executable |
| `STT_TRANSCRIBE_CLI` | `transcribe-cli` | transcribe.cpp executable |
| `STT_TEMP_DIR` | OS temp | temporary-file parent |
| `STT_MAX_BODY_BYTES` | 33554432 | complete HTTP body limit |
| `STT_MAX_AUDIO_BYTES` | 25165824 | decoded file/raw audio limit |
| `STT_CONCURRENCY` | 2 | in-flight request slots; excess gets 429 |
| `STT_DEADLINE_SECONDS` | 120 | end-to-end request deadline |

`GET /healthz` (`/health`) is process liveness and `GET /readyz` (`/ready`) says
the stable proxy can accept demand. Lazy local validation happens on first
transcription; unavailable tools/model return 503. Invalid request, oversized
body/audio, invalid audio, backend failure, and timeout map to 400, 413, 422,
502, and 504 respectively. Responses are JSON except upstream responses, which
are passed through byte-for-byte with their status and end-to-end headers.

The server handles SIGINT/SIGTERM with a 10-second graceful drain. Request
cancellation/deadlines terminate local child process groups as managed by Go's
`CommandContext`; temporary directories are then removed.

## Development

```sh
go test ./...
nix flake check
nix build
```
