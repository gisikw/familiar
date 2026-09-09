# Familiar's downstream Pi patch (no fork)

This directory owns the Nix adaptation of **earendil-works/pi v0.84.1** used
by the top-level locked nixpkgs. It is not an extension and does not belong in
`integrations/pi`. There is no replacement source checkout, maintained git fork,
or npm dependency change. `default.nix` overrides the existing nixpkgs derivation;
its workspace build, dependency hashes, wrappers and platform cleanup are retained.
Both default/pi shells and `PI_PACKAGE_DIR` use this package. It is also exported
as `packages.<system>.pi-coding-agent` and `checks.<system>.pi-invoke-command`.

## API contract

```ts
const command = pi.getCommands().find(c => c.source === "extension" && c.name === "review:2");
if (command) await pi.invokeCommand(command.name, "unchanged args");
```

`ExtensionAPI.invokeCommand(name: string, args?: string): Promise<void>`:

- Uses `ExtensionRunner.getCommand` at invocation time: exact invocation names,
  including numeric collision suffixes, without `/`. No raw callbacks are exposed.
- Only registered extension commands are targets. `getCommands()` also lists
  prompt templates and skills; those are **not** invokable here. Built-in
  interactive commands such as `/model` and `/settings` are not in that list.
- Passes args unchanged (omitted means `""`), creates the existing guarded
  `ExtensionCommandContext`, and awaits completion. No input events, LLM turn,
  prompt expansion, argument parsing, or implicit idle wait.
- Rejects unknown names and stale/uninitialized runtimes. Handler `Error`s keep
  their identity/stack; other thrown values become `Error(String(value))`, as in
  Pi's existing async compaction error normalization.
- Programmatic failures belong to the caller: no duplicate `emitError` side
  effect. Prompt dispatch uses the same runner operation but keeps upstream's
  report-and-consume behavior. Reporting is on the originating runner even if
  the handler replaced the session before throwing.
- Runner-local active-name tracking rejects direct/indirect async recursion
  **and concurrent invocation of the same name**. Different names may overlap,
  up to 16 active invocations. Prompt dispatch participates in the guard. Cleanup
  is in `finally`, including throws and runtime replacement. This is intentionally
  conservative rather than introducing async-local context or a command queue.
- Successful replacement/reload may resolve the invocation. It does not revive
  captured old `pi`/`ctx`. Subsequent calls reject and context getters/actions
  retain upstream stale checks. No post-handler active assertion falsely turns
  successful replacement into failure. New runtimes have independent guards.

### Important call-site limitation / unresolved design risk

This is immediate command composition, **not a safe scheduling API**. Upstream's
`docs/extensions.md` warns that command-context session controls can deadlock
from event handlers. A tool/event awaiting a command that waits for that same
agent/event to settle can still deadlock; the recursion guard is not a general
wait-for graph. Do not invoke such commands from tools or lifecycle callbacks.
Use the existing `sendUserMessage(..., { deliverAs: "followUp" })` handoff instead.
UI availability and cancellation remain the handler's/mode's responsibility.
There is no timeout, cancellation injection, sandbox, or rollback of handler side
effects. Fire-and-forget work after handler completion is outside the invocation
lifetime. Further upstream research may justify a stricter call-site fence or a
separate queued API; this patch does not claim to solve those problems.

## Fail-closed update procedure

Inspected nixpkgs `pkgs/by-name/pi/pi-coding-agent/package.nix`: it builds the
GitHub monorepo (not the published coding-agent tarball), uses tsgo for workspace
deps, restores the model catalogue from matching npm pi-ai, then installs compiled
coding-agent output at `lib/node_modules/pi-monorepo`.

Evaluation asserts version **0.84.1**, the exact upstream source hash, and absence
of upstream patches/prePatch modifications. Before applying any patch, SHA-256
checks cover whole `loader.ts`, `runner.ts`, `types.ts`, `agent-session.ts`, root
and coding-agent package manifests, and lockfile. This pins command resolution,
context construction, prompt dispatch, getCommands binding, and stale/reload
internals, not just nearby patch context. Source rearrangements fail before patch
application; patch fuzz is not the verification mechanism.

On an upstream bump, inspect the new source and nixpkgs build recipe, revisit
semantics and tests, and only then regenerate hashes/patch. Do not merely relax
assertions or refresh checksums to make a build green.

## Tests and validation

`invoke-command.test.mjs` imports the **compiled** loader, runner and AgentSession.
It exercises factory registration, real session getCommands binding, args/defaults,
suffix resolution, async completion through an explicit barrier, unknown/non-extension
names, sync Error identity and async non-Error normalization, direct/indirect cycles,
concurrency and depth bounds, guard cleanup, prompt error reporting, and stale API/
context behavior during and after replacement/reload. Session/resource I/O is stubbed
at the mode-action boundary; these are not full TUI or disk-backed lifecycle tests.

It runs in `checkPhase` and again unconditionally in `postInstall`, against the
installed runtime, plus an installed declaration assertion. Setting `doCheck` or
`doInstallCheck` false cannot silently skip installed validation. No network, real
model, operator state, or resident Presence is used.

Commands used from the repository root (x86_64-linux):

```sh
nix build .#pi-coding-agent --no-link -L
nix build .#checks.x86_64-linux.pi-invoke-command .#checks.x86_64-linux.drop-serve-lifecycle --no-link -L
nix flake check --no-build
nix flake check -L
nix eval --raw .#checks.aarch64-linux.pi-invoke-command.drvPath
nix eval --raw .#checks.aarch64-darwin.pi-invoke-command.drvPath
nix develop .#pi -c /nix/store/glcp73hgagq2b24i80jlgbvj28vdb6kk-nodejs-24.19.0/bin/node test/extension-loader-smoke.mjs
nix develop .#pi -c bash -c 'bash test/pi-extra-extensions.test.sh && bash test/pi-model-store.test.sh'
```

The existing pi shell does not put Node on PATH; the smoke command explicitly uses
the locked package's Node interpreter. `nix flake check --no-build --all-systems`
was also attempted: it fails in the existing gateway Darwin output referencing
missing `viewer.packages.aarch64-darwin`, unrelated to this patch. Both non-native
patched checks evaluate successfully; only x86_64-linux was built here.

Negative verification (both must fail loudly):

```sh
nix eval --impure --expr 'let f = builtins.getFlake (toString ./.); p = f.inputs.nixpkgs.legacyPackages.x86_64-linux; in (import ./nix/patches/pi-coding-agent { pkgs = p // { pi-coding-agent = p.pi-coding-agent.overrideAttrs { version = "0.84.2"; }; }; }).drvPath'
nix build --no-link --impure --expr 'let f = builtins.getFlake (toString ./.); in f.packages.x86_64-linux.pi-coding-agent.overrideAttrs { postUnpack = "echo tampered >> source/packages/coding-agent/src/core/agent-session.ts"; }'
```

The former rejected the version at evaluation; the latter rejected the modified
source checksum in prePatch before patch application.

Also built with both optional check flags disabled; installed validation still ran
and passed:

```sh
nix build --no-link -L --impure --expr 'let f = builtins.getFlake (toString ./.); in f.packages.x86_64-linux.pi-coding-agent.overrideAttrs { doCheck = false; doInstallCheck = false; }'
```
