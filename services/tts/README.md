# Familiar TTS

A stable loopback-only HTTP speech proxy. It forwards to a configured upstream,
or starts a selected local Kokoro backend only when synthesis is first requested.
TTS.cpp remains the Linux default; the optional nixpkgs-native PyTorch backend is
available on Linux and Apple Silicon Darwin.

## HTTP contract

* `POST /v1/audio/speech` validates bounded JSON, then forwards it unchanged and
streams status, safe end-to-end headers, and binary output. `input` is required;
`voice` and unknown OpenAI-compatible fields are preserved. Synthesis is never
retried.
* `GET /livez` reports proxy liveness.
* `GET /readyz` is 200 immediately in forwarding mode (it means the local proxy
is ready, not that a remote provider was probed). In local mode it becomes 200
only after the backend accepts a bounded TCP readiness probe and returns to 503
when the child exits. TTS.cpp binds after model load; TCP acceptance therefore
means it is serving. The probe does not merely check that a process spawned.

The default bind is `127.0.0.1:9933`; public exposure must be explicit. Client
`Authorization` and `Cookie` are always stripped. Provider credentials must be
configured explicitly and are never logged.

## CLI and environment

Every CLI option has the corresponding uppercase `FAMILIAR_TTS_*` environment
name. CLI takes precedence. Sizes are bytes and durations use Go syntax.

| CLI | Environment | Default |
|---|---|---|
| `--listen` | `FAMILIAR_TTS_LISTEN` | `127.0.0.1:9933` |
| `--upstream` | `FAMILIAR_TTS_UPSTREAM` | unset (local mode) |
| `--upstream-authorization` | `FAMILIAR_TTS_UPSTREAM_AUTHORIZATION` | unset |
| `--upstream-header 'Name: value'` (repeatable) | `FAMILIAR_TTS_UPSTREAM_HEADERS` (JSON string map) | unset |
| `--backend` | `FAMILIAR_TTS_BACKEND` | `http://127.0.0.1:19933` |
| `--local-backend` | `FAMILIAR_TTS_LOCAL_BACKEND` | `ttscpp` |
| `--backend-command` | `FAMILIAR_TTS_BACKEND_COMMAND` | `tts-server` (`familiar-kokoro-server` for `kokoro`) |
| `--model` | `FAMILIAR_TTS_MODEL` | `$STATE/models/Kokoro_espeak_Q8.gguf` |
| `--model-url` | `FAMILIAR_TTS_MODEL_URL` | immutable Hugging Face revision |
| `--voice` | `FAMILIAR_TTS_VOICE` | unset |
| `--voices-source` | `FAMILIAR_TTS_VOICES_SOURCE` | unset |
| `--state-dir` | `FAMILIAR_TTS_STATE_DIR` | `./state` |
| `--age-key` | `FAMILIAR_TTS_AGE_KEY` | unset |
| `--baker` | `FAMILIAR_TTS_BAKER` | `familiar-bake-kokoro` |

The `kokoro` backend also has `--model-sha256`, `--kokoro-config[-url|-sha256]`,
and `--kokoro-voice-file[-url|-sha256]`. Its pinned defaults download the
upstream `.pth`, `config.json`, and `af_heart.pt` into state. Exact sizes are
controlled by `MODEL_SIZE`, `KOKORO_CONFIG_SIZE`, and `KOKORO_VOICE_SIZE`.

Environment-only controls (all prefixed `FAMILIAR_TTS_`): `BACKEND_ARGS`,
`MAX_BODY` (1048576), `MAX_INPUT` (65536), `CONCURRENCY` (4), `STARTUP_TIMEOUT`
(60s), `DOWNLOAD_TIMEOUT` (30m), `REQUEST_TIMEOUT` (5m), `SHUTDOWN_TIMEOUT`
(5s), `MODEL_MIN_SIZE` (104857600), and `MODEL_SIZE` (186180864; set 0 for a
different validated GGUF). The pinned default is revision
`e9e81d8e813948353195c9db77ef065476335c8d`.

Downloads use a persistent `.part`, HTTP Range resume, fsync, GGUF magic and
size validation, then same-filesystem rename. HTML, Git LFS pointers, truncated
files, and partial artifacts are rejected without replacing a valid model.
Download timeout is independent from backend startup. Startup/baking is a
service-owned single flight bounded by `STARTUP_TIMEOUT`: cancellation of one
waiting request does not cancel shared work, while service shutdown does.

## Backends and custom voices

The default `.#familiar-tts` closure and behavior are unchanged and deliberately
exclude Python/Torch. `.#familiar-tts-kokoro` selects the native hexgrad Kokoro
package and accepts `wav`, `flac`, and signed 16-bit `pcm` response formats. It
loads `.pt` tensors directly: set `--voices-source /private/voices` and request
`af_exo` to load `/private/voices/af_exo.pt`. Files are not copied, decrypted,
or converted; protect them appropriately. GGUF baked voices are not compatible
with this backend.

For the TTS.cpp path, install
`.#familiar-tts-with-voice-baker`, or install `.#baker` separately and set
`FAMILIAR_TTS_BAKER`, only when custom packs are needed. `--voices-source` may
contain `.pt` or `.pt.age`; packs are staged mode 0600 outside the Nix store and
baked into an atomic private model. Baker executable SHA-256 participates in
invalidation in addition to source/model mtimes. Decryption and baking occur
only at runtime, never Nix evaluation/build.

## Build and test

```sh
go vet ./...
go test ./...
go test -race ./...
nix flake check
nix build .#familiar-tts
nix build .#familiar-tts-with-voice-baker
nix build .#familiar-tts-kokoro
```

The service and bundled baker are MIT licensed (`LICENSE`). Pinned TTS.cpp is
also MIT; hexgrad Kokoro and its weights are Apache-2.0; Python/Torch/GGUF
retain their upstream licenses in Nixpkgs. See `KOKORO-NOTES.md` for research,
platform evidence, limitations, and the real-Mac verification checklist.
