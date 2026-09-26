# familiar-worker-runtime

`packages.<system>.familiar-worker-runtime` is the smallest public, immutable
runtime a fleet worker node needs to launch Familiar's patched Pi under Herdr.
It is built for every system the top-level flake already supports
(`x86_64-linux`, `aarch64-linux`, `aarch64-darwin`).

```sh
nix build .#familiar-worker-runtime
nix build github:gisikw/familiar/<40-hex-commit>#familiar-worker-runtime
```

## Layout

```text
bin/                         one merged bin directory (buildEnv, collisions fail)
  pi                         fail-closed launcher for patched Pi 0.85.1
  herdr                      pinned Herdr 0.9.1 release CLI (flake input `herdr`)
  bash git jq rg fd python3 ssh ssh-keygen ...   worker tools (below)
share/familiar-worker/
  runtime.json               schema-1 machine-readable metadata
  extensions/                public Pi extension sources shipped with the runtime
    tiamat/*.ts, README.md   the Tiamat provider extension
    lib/debug.ts             its only shared dependency (derived, not listed)
  profile/settings.json      versioned default worker profile template
```

The `bin` directory is the whole execution surface. A node puts it on the
pane shell's PATH (for example through a stable `current` pointer); Herdr's
`agent.start --kind pi` then resolves this exact launcher. The launcher checks
`FAMILIAR_TIAMAT_URL` and `FAMILIAR_TIAMAT_TOKEN_FILE` before it execs the
immutable patched Pi store path with arguments unchanged. The token path must
name a readable, regular, nonempty file; a dummy nonempty token is acceptable
for an unauthenticated router. Missing or invalid inputs fail immediately with
a concise `Failed to start pi: ...` error. This policy belongs only to the
fleet runtime entrypoint: `packages.<system>.pi-coding-agent` and resident Pi
continue to invoke the patched package directly.

### Worker tools

The tool set is what the resident `pi` shell and the isolated `agents` shell
already make explicit, minus resident-only media/secret tooling:
interactive Bash, coreutils, findutils, grep/sed/awk, Git, jq, ripgrep, fd,
Python 3, OpenSSH. Process basics are platform dependent: `procps` and
`util-linux` are included on Linux only; Darwin keeps its system
`ps`/`pgrep`/`lsof` under `/bin` and `/usr/bin`.

### Extension material

`share/familiar-worker/extensions` is produced at build time by the same
`workerProfileArtifact()` walker the Agents controller uses for generated
per-job profiles (`integrations/pi/extensions/agents/transport.mjs`): the
exact relative-import module graph reachable from `tiamat/index.ts`, regular
`.ts` files only. No hand-maintained module list exists; adding or removing an
import changes the shipped tree by construction. `checks.<system>.worker-runtime`
verifies the shipped tree equals that graph byte-for-byte.

### Profile template

`profile/settings.json` contains only the public extension path (the
immutable store path of this output), `defaultProjectTrust: "never"`, and
`lastChangelogVersion`. A node that prefers a stable pointer path may rewrite
the extension entry. Providers and credentials never appear here: Tiamat is
configured at launch through `FAMILIAR_TIAMAT_URL` and the absolute
`FAMILIAR_TIAMAT_TOKEN_FILE` reference, and reads the token file per request
(see `integrations/pi/extensions/tiamat/README.md`). The fleet `bin/pi`
launcher refuses to start without valid values rather than allowing the
extension to come up disabled.

### runtime.json

```json
{
  "schema": 1,
  "name": "familiar-worker-runtime",
  "familiar_rev": "<40-hex commit, -dirty suffixed for dirty trees, or unknown>",
  "system": "x86_64-linux",
  "pi": { "version": "0.85.1", "upstream_commit": "d981de…", "patches": ["invoke-command.patch", "model-bootstrap.patch"], "store_path": "/nix/store/…", "entrypoint": "bin/pi", "fail_closed_tiamat": true },
  "herdr": { "name": "herdr", "version": "0.9.1", "store_path": "/nix/store/…", "nix_input_revision": "2bcfa02424385730d0c65cfa8cd355bb3afecef8" },
  "tools": [ { "name": "git", "version": "…", "store_path": "/nix/store/…" }, … ],
  "extensions": ["tiamat"],
  "profile_template": "share/familiar-worker/profile/settings.json"
}
```

Consumers must require `schema == 1` and reject unknown schemas.

## Deliberately absent

No secrets, token files, auth store, session history, private instance
configuration, generated model catalogue, mutable state, repository checkout,
or host-specific path. No release manifest, credential exchange, update
daemon, or activation logic: selecting, validating, and pointing at a build is
the fleet client's job.

## Validation

```sh
nix build .#checks.<system>.worker-runtime
node test/worker-runtime.mjs "$(nix build .#familiar-worker-runtime --print-out-paths)" integrations/pi/extensions
```

The check asserts the required executables per platform; every failure path
and the successful exec path of the Pi launcher; the patched Pi version and
downstream API surface; Herdr 0.9.1 and its exact herdr-nix revision
`2bcfa02424385730d0c65cfa8cd355bb3afecef8`; schema-1 metadata; the derived
extension tree; and a template free of providers and host paths. The top-level
flake also asserts that the resolved Herdr input has that revision, making
input/lock drift an evaluation failure.
