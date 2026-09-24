# Shared packages implementation notes

## Scope decision

Built only `client-protocol` and `config`. `packages/ui` was intentionally not created: `docs/ARCHITECTURE.md` says boundaries should appear only when they receive owned code, and the current gateway/desktop assets do not yet constitute a shared UI library.

## `@familiar/client-protocol`

The v1 schema formalizes the Gateway's existing surfaces without exposing pi-protocol or requiring a flag day:

- `services/gateway/src/pty.ts`: attach/input/resize, byte-clean PTY output, status/exit;
- `services/gateway/src/ingress.ts`: text submits, chunked voice takes, STT, cancellation, correlation;
- `services/gateway/src/protocol.ts`, `hub.ts`, and `audio.ts`: session epochs, message revisions/locking, tools, TTS segments, replay;
- `services/gateway/src/upload.ts`: file relay and Presence notification result;
- `integrations/pi/extensions/scheduler`: scheduler push delivery and acknowledgement.

The protocol uses negotiated integer versions, Familiar-owned message names, bearer-auth shape, per-stream monotonic sequences, resume cursors, acknowledgements, replay truncation, and session epochs. Unknown fields are additive. `validateLegacySubmit` gives the current HTTP ingress an immediate low-risk adoption point; later the Gateway can translate SSE/restty/upload routes behind a v1 WebSocket while keeping old routes until clients move.

## `@familiar/config`

This package formalizes `docs/CONFIG.md`, `familiar.toml.example`, and the current `scripts/familiar-config.{sh,nix}` behavior. It defines every documented canonical table/key, uses Bun's built-in TOML parser, rejects unknown/flat settings, enforces 0600, applies defaults then canonical `FAMILIAR_*` overrides, validates mutually exclusive Claude credential forms, and provides recursive redaction. It returns an environment snapshot rather than mutating the process.

Later migration: make `familiar.sh`/the supervisor consume the package (or a small Bun config command) and compare its flattened snapshot against the Nix loader in tests before retiring that loader. Preserve existing explicit-ambient provenance and upstream aliases (`PI_*`, `ANTHROPIC_*`, etc.) in the integration layer; they are process-launch policy, not canonical config fields.

## Verification

Each package has an independent Bun package, lockfile, strict no-emit TypeScript config, Bun/Nix development flake, README, and tests. Tests cover malformed protocol/config/state and config mode/redaction/env precedence.
