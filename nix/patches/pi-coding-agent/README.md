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
if (command) await pi.invokeExtensionCommand(command.name, "unchanged args");
```

`ExtensionAPI.invokeExtensionCommand(name: string, args?: string): Promise<void>`:

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
- Requires the runner's bound owning `AgentSession.isIdle` to return exactly true
  at admission. Unbound runners fail closed. Active-run tools/events reject before
  a command context is created; no wait or queue can deadlock on the caller.
- One runner-local exclusive command slot rejects **all nested and concurrent
  commands**, including A → B. Different names still mutate the same session;
  a name set/depth limit does not protect that shared state. Rejecting rather than
  queueing also avoids nested callers waiting on themselves. Prompt dispatch
  shares exclusivity but uses an internal entry point **without the public idle
  restriction**, retaining upstream immediate command handling during streaming.
  Cleanup is in `finally`, including throws and runtime replacement.
- Successful replacement/reload may resolve the invocation. It does not revive
  captured old `pi`/`ctx`. Subsequent calls reject and context getters/actions
  retain upstream stale checks. No post-handler active assertion falsely turns
  successful replacement into failure. New runtimes have independent guards.

### Why preserve the fence?

Sol's Chesterton's Fence research (09a039b, `pi-command-invocation-fence.md`)
identifies upstream commit [0d9fddec](https://github.com/earendil-works/pi/commit/0d9fddec1eacfa5a535ad5f93a170cacdd2fad30)
and [issue #2023](https://github.com/earendil-works/pi/issues/2023#issuecomment-4060338341)
as deliberate deadlock/lifecycle boundaries, not missing plumbing. Ordinary
awaited tools/events cannot safely wait for or mutate their own active pipeline.
Familiar's external human browser frontend already gates actions at idle, but
this general API now enforces its own admission fence rather than trusting that
frontend or documentation. The name `invokeExtensionCommand` deliberately excludes
built-ins/templates/skills; there is no broad `invokeCommand` compatibility alias.

We remain pinned to verified **0.84.1**. Its owning-session `isIdle` is backed by
`_isAgentRunActive`, which spans the run and post-run retries/continuations, not
just `agent.state.isStreaming`. This is the upstream lifecycle predicate, not a
new quiescence implementation. The API checks it synchronously before dispatch.
It is not a scheduler, provenance check, or session-wide lock: idle callbacks can
call it, and unrelated host actions must still be gated throughout the handler.
The internal prompt entry point is not exposed on `pi`; SDK hosts retain their
upstream ability to dispatch commands while busy. Nested/overlapping prompt
commands now report an error instead of overlapping session mutation.

Do **not** queue slash text via `sendUserMessage(... followUp)` as a substitute:
in 0.84.1 this is literal model-visible text. 0.84.2's `expandPromptTemplates`
opt-in dispatches before streaming queueing, is void on the extension facade,
and expands skills/templates too. It does not replace an awaited idle-only API.

UI availability and cancellation remain the handler's/mode's responsibility.
There is no timeout, cancellation injection, sandbox, or rollback. Fire-and-forget
work after handler completion is outside the slot lifetime. Admission cannot
prevent a handler from starting another run or misusing captured raw objects.

## Fail-closed update procedure

Inspected nixpkgs `pkgs/by-name/pi/pi-coding-agent/package.nix`: it builds the
GitHub monorepo (not the published coding-agent tarball), uses tsgo for workspace
deps, restores the model catalogue from matching npm pi-ai, then installs compiled
coding-agent output at `lib/node_modules/pi-monorepo`.

Evaluation asserts version **0.84.1**, the exact upstream source hash, and absence
of upstream patches/prePatch modifications. Before applying any patch, SHA-256
checks cover whole `loader.ts`, `runner.ts`, `types.ts`, `agent-session.ts`, root
and coding-agent package manifests, lockfile, and the patched extension API docs. This pins command resolution,
context construction, prompt dispatch, getCommands binding, and stale/reload
internals, not just nearby patch context. Source rearrangements fail before patch
application; patch fuzz is not the verification mechanism. The existing pristine
source hashes are unchanged; the extension-docs hash is added because those docs
are now patched too. `invoke-command-shape.test.mjs` additionally checks the patched
idle binding, owning-session getter, prompt-before-streaming ordering, internal
prompt path, exclusive guard, and absence of a public bypass/legacy alias.

On an upstream bump, inspect the new source and nixpkgs build recipe, revisit
semantics and tests, and only then regenerate hashes/patch. Do not merely relax
assertions or refresh checksums to make a build green.

## Tests and validation

`invoke-command.test.mjs` imports the **compiled** loader, runner and AgentSession.
It exercises factory registration, real session getCommands binding, args/defaults,
suffix resolution, async completion through an explicit barrier, unknown/non-extension
names, sync Error identity and async non-Error normalization, self-invocation and
A → B exclusion, same/different-name concurrency rejection, busy public/event/tool
rejection, guard cleanup, real `AgentSession.prompt()` execution while busy,
prompt error reporting, and stale API/
context behavior during and after replacement/reload. Session/resource I/O is stubbed
at the mode-action boundary; these are not full TUI or disk-backed lifecycle tests.

Source shape checks run in `postPatch`. Runtime tests run in `checkPhase` and again
unconditionally in `postInstall`, against the
installed runtime, plus an installed declaration assertion. Setting `doCheck` or
`doInstallCheck` false cannot silently skip installed validation. No network, real
model, operator state, or resident Presence is used.

Revision validation: all commands below were rerun successfully on x86_64-linux,
except the explicitly noted existing all-systems Darwin evaluation failure.
Both negative checks failed for their intended reasons (version assertion and
pristine source checksum), and disabled-check-flags validation still passed.
Non-native outputs were evaluated, not built.

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
