# Familiar TTS

A stable, loopback-only HTTP speech proxy. It forwards to a configured upstream,
or starts a local TTS.cpp Kokoro server only when synthesis is first requested.

## HTTP contract

* `POST /v1/audio/speech` forwards the validated JSON body unchanged and streams
the response status, safe end-to-end headers, and binary body unchanged. Familiar
currently requires `input` and may send `voice`; unknown OpenAI-compatible fields
are preserved. A synthesis is never retried.
* `GET /livez` reports that the proxy is alive.
* `GET /readyz` is 200 for forwarding mode and, in local mode, only while the
backend is running. Readiness does not eagerly start it.

The default bind is `127.0.0.1:9933`; public exposure must be explicit.

## CLI and environment

Every CLI option below has an environment equivalent. CLI takes precedence.
Size values are bytes and durations use Go syntax (`30s`, `5m`).

| CLI | Environment | Default |
|---|---|---|
| `--listen` | `FAMILIAR_TTS_LISTEN` | `127.0.0.1:9933` |
| `--upstream` | `FAMILIAR_TTS_UPSTREAM` | unset (local mode) |
| `--backend` | `FAMILIAR_TTS_BACKEND` | `http://127.0.0.1:19933` |
| `--backend-command` | `FAMILIAR_TTS_BACKEND_COMMAND` | `tts-server` |
| `--model` | `FAMILIAR_TTS_MODEL` | `$STATE/models/Kokoro_espeak_Q8.gguf` |
| `--model-url` | `FAMILIAR_TTS_MODEL_URL` | pinned Kokoro download URL |
| `--voice` | `FAMILIAR_TTS_VOICE` | unset |
| `--voices-source` | `FAMILIAR_TTS_VOICES_SOURCE` | unset |
| `--state-dir` | `FAMILIAR_TTS_STATE_DIR` | `./state` |
| `--age-key` | `FAMILIAR_TTS_AGE_KEY` | unset |
| `--baker` | `FAMILIAR_TTS_BAKER` | `familiar-bake-kokoro` |

Additional environment-only controls: `FAMILIAR_TTS_BACKEND_ARGS` (whitespace
split), `FAMILIAR_TTS_MAX_BODY` (1048576), `FAMILIAR_TTS_MAX_INPUT` (65536),
`FAMILIAR_TTS_CONCURRENCY` (4), `FAMILIAR_TTS_STARTUP_TIMEOUT` (60s),
`FAMILIAR_TTS_REQUEST_TIMEOUT` (5m), and `FAMILIAR_TTS_SHUTDOWN_TIMEOUT` (5s).

`--voices-source` may contain `<name>.pt` or `<name>.pt.age`. Packs are copied or
decrypted with `age -i`, mode 0600, under the state directory, then baked into an
atomic private runtime model copy. Downloads and baking also use same-filesystem
temporary files and rename. No key or request body is logged. Preparation and
backend startup are single-flight. A dead backend is restarted on the next
request; an in-flight failed synthesis is returned as 502 and is not replayed.
The backend process group receives TERM, then KILL after the shutdown deadline.

## Build and test

```sh
go test ./...
nix flake check
nix build
```

`flake.nix` independently pins TTS.cpp and packages `tts-server`, `age`, the GGUF
and Torch baking environment, and this proxy. Decryption and voice baking happen
only at runtime; private voice data is never imported into a Nix derivation.
