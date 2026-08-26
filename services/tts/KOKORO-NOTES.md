# Kokoro backend investigation (2026-08-21)

## Recommendation

Use nixpkgs' `python3Packages.kokoro` (hexgrad's PyTorch implementation) plus a
small service-owned HTTP adapter. This is the only route examined that is both
already packaged in the pinned nixpkgs and directly consumes the owner's `.pt`
voice tensors. Keep TTS.cpp as the Linux default because its closure is much
smaller; expose native Kokoro as `.#familiar-tts-kokoro` on Linux and
`aarch64-darwin`.

The recommendation is viable but Darwin remains evaluation-level evidence until
run on a Mac. The flake evaluates and computes a complete aarch64-darwin build
plan; this x86_64-linux host cannot execute that plan or test MPS/libespeak.
CPU is the adapter default. MPS is deliberately not claimed.

## Package survey and evidence

Pinned nixpkgs revision: `ffb3c9b700e759be2ef13237c9d8f953b32a1e46`.
Commands used included `nix eval` with both host systems, `nix build --dry-run`,
and inspection of the nixpkgs expressions.

| Component | pinned version | nixpkgs result | declared/evaluated platforms |
|---|---:|---|---|
| `python3Packages.kokoro` | `0-unstable-2025-06-16`, upstream rev `2668b2e…` | present, not broken | x86_64-linux, aarch64-linux, aarch64-darwin (among others) |
| `python3Packages.misaki` | `0-unstable-2025-06-16`, rev `49ddead…` | present; nixpkgs patches fixed espeak library/data paths | same relevant three |
| `espeak-ng` | `1.52.0.1-unstable-2025-09-09` | present, not broken | includes aarch64-darwin and Linux |
| `onnxruntime` / Python binding | `1.27.1` | present, not broken | includes aarch64-darwin and Linux |
| `python3Packages.kokoro-onnx` | upstream PyPI 0.6.1 | **no nixpkgs attribute** | not directly packageable without a new expression and dependency adaptation |

`python3.withPackages (p: [p.kokoro p.soundfile])` produced an
aarch64-darwin dry-run closure including nixpkgs Torch 2.12.0. The final
`familiar-tts-kokoro` derivation and its dependencies also dry-run for Darwin.
This verifies evaluation, platform metadata, and dependency planning—not
successful Darwin compilation or runtime synthesis.

Upstream state checked:

* [hexgrad/kokoro](https://github.com/hexgrad/kokoro) is the model author's
  maintained inference library, Apache-2.0, using Misaki and PyTorch. Upstream
  documents Apple Silicon and optional MPS fallback.
* [thewh1teagle/kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) is an
  active MIT wrapper (PyPI 0.6.1), documents near-real-time M1 operation, and
  requires ONNX plus a `voices-v1.0.bin` NPZ archive. It is attractive for a
  smaller runtime, but is absent from this nixpkgs and its PyPI dependency on
  `espeakng-loader` conflicts with the cleaner nixpkgs-patched phonemizer route.
* [remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) provides the
  exact OpenAI endpoint and direct `.pt` workflow, and now documents direct Mac
  execution. Its large, fast-changing application dependency set is not in
  nixpkgs; packaging the whole server would be less maintainable than the thin
  adapter. OCI images remain a Linux/container deployment path, not this answer.

## Voice and artifact compatibility

* TTS.cpp embeds/bakes voice data into GGUF. Those baked files remain specific
  to TTS.cpp.
* hexgrad Kokoro loads `voices/<name>.pt` with `torch.load(...,
  weights_only=True)`. The alternative backend therefore directly uses custom
  files such as `af_exo.pt`: point `--voices-source` at the directory and send
  voice `af_exo`. No conversion or access to the owner's files is required.
* Kokoro-FastAPI also uses `.pt`, so voice tensors made for the same Kokoro model
  revision should have the expected style-vector shape. Familiar does not
  promise compatibility with arbitrary pickles or other model revisions.
* kokoro-onnx's `voices-v1.0.bin` is an NPZ mapping voice names to NumPy arrays.
  A `.pt` tensor would need safe loading in a trusted PyTorch environment,
  conversion to NumPy, shape/dtype verification, and insertion into an NPZ.
  Upstream does not advertise direct `.pt` loading; Familiar implements no such
  conversion.

The pinned runtime downloads are model `kokoro-v1_0.pth` (327,212,226 bytes,
SHA-256 `496dba11…ad1e4`), config (2,351 bytes, SHA-256 `5abb01e2…c17f`), and
`af_heart.pt` (523,425 bytes, SHA-256 `0ab5709b…b4ff`) from immutable HF revision
`f3ff3571791e39611d31c381e3a41a3af07b4987`. Each uses persistent Range resume,
a response-size cap, fsync, exact-size plus full SHA-256 validation, and atomic
same-filesystem rename. Invalid partials never replace valid artifacts. Custom
voice directories are explicit trusted local provisioning and are not modified.

## API and implementation

The proxy verifies and forwards `POST /v1/audio/speech` unchanged. The adapter
implements that route directly, preserving `input`, `voice`, `speed`, and
`response_format`; it currently supports WAV, FLAC, and PCM. Kokoro-FastAPI has
a broader exact API (MP3/Opus/AAC, mixing, streaming), but that breadth is not
needed for the stable proxy contract. Unsupported formats receive HTTP 400.

Backend selection is `--local-backend=ttscpp|kokoro`; default remains `ttscpp`.
All existing lifecycle properties are shared: service-owned single-flight lazy
startup, separate download/startup deadlines, TCP readiness after full model
load, crash detection/restart, and process-group TERM/KILL shutdown. The adapter
serializes model access because upstream does not document cache thread safety.
It never logs request bodies.

## Darwin owner checklist (not yet verified here)

On a real Apple Silicon Mac with Nix flakes enabled:

1. `nix build .#packages.aarch64-darwin.familiar-tts-kokoro`
2. `nix path-info -Sh .#packages.aarch64-darwin.familiar-tts-kokoro`
3. Start `./result/bin/familiar-tts --state-dir "$TMPDIR/familiar-tts-test"`.
4. Confirm `/readyz` is 503 before synthesis.
5. POST a short WAV request with `voice: af_heart`; allow the pinned downloads;
   verify HTTP 200, valid 24 kHz mono audio, then `/readyz` 200.
6. Restart during a partially downloaded model and confirm `.part` resumes and
   the destination appears only after SHA-256 validation.
7. Put a trusted `af_exo.pt` in a mode-0700 directory, restart with
   `--voices-source DIR --voice af_exo`, and synthesize without network voice
   fetching.
8. Kill the backend child, synthesize again, and verify one restart. Terminate
   the proxy and verify no backend descendants remain.
9. Run `go vet ./...` and `go test -race ./...` in `services/tts`.

Record macOS version, Nix version, build result, CPU/RSS, first-request latency,
and whether espeak fallback pronounces an out-of-dictionary English word. Do
not enable/claim MPS until a separate test demonstrates correctness; CPU is the
supported baseline.
