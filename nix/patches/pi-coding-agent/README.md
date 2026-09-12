# Familiar's downstream Pi patch (no fork)

This directory owns the Nix adaptation of **earendil-works/pi v0.85.1** used
by the top-level locked nixpkgs. It is not an extension and does not belong in
`integrations/pi`. There is no replacement source checkout or maintained git fork.
`default.nix` adapts the locked nixpkgs 0.84.1 recipe to immutable upstream commit
`d981de1229ef899957bbe968bc8dcda02a21f477`, including the exact 0.85.1 source,
npm dependency, model-data, workspace-build and install metadata. The nixpkgs
wrappers, install checks and platform cleanup remain in force. In particular,
the 0.85.1 Darwin post-install step removes both foreign Linux seccomp vendor
directories from `@anthropic-ai/sandbox-runtime`; Darwin derivation inspection
is part of the release check.
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
  effect. `AgentSession.prompt` keeps upstream's direct handler invocation,
  context creation, and report-and-consume error behavior byte-for-byte.
- Requires a separate owning-session admission predicate to return exactly true:
  `session.isIdle && _agentSettledDispatchDepth === 0`. Unbound runners fail closed.
  Public calls also reject while **any awaited runner event dispatch is active**,
  even if the session is idle, with `Extension command unavailable during event dispatch`.
  Active-run tools/events and the entire `_emitAgentSettled` dispatch reject before
  a command context is created; no wait or queue can deadlock on the caller.
  The depth spans both extension dispatch and synchronous session listeners and
  is restored in `finally`. Public `isIdle` semantics are unchanged.
- One runner-local exclusive slot rejects nested/concurrent **public API calls**,
  including A → B. Cleanup is in `finally`, including throws and replacement.
  Existing prompt dispatch neither checks nor acquires this slot. Prompt commands
  retain immediate/overlapping behavior, even during a public invocation or while
  streaming. Browser/terminal concurrency remains the host's responsibility.
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

We remain pinned to verified **0.85.1**. Its owning-session `isIdle` is backed by
`_isAgentRunActive` and `isCompacting`; the former spans the run and post-run
retries/continuations, rather than only `agent.state.isStreaming`. This is the
upstream lifecycle predicate, not a new quiescence implementation. Because `_emitAgentSettled` clears that flag before
awaiting handlers, the separate session-owned dispatch depth fences that interval
without changing `ctx.isIdle()` (which is true inside `agent_settled`). Admission
checks both synchronously, plus runner event dispatch depth, before acquiring the
public-only exclusive slot.

An exhaustive 0.85.1 runner audit found 11 awaited handler-dispatching methods:
`emit`, `emitMessageEnd`, `emitToolResult`, `emitToolCall`, `emitUserBash`,
`emitContext`, `emitBeforeProviderRequest`, `emitBeforeProviderHeaders`,
`emitBeforeAgentStart`, `emitResourcesDiscover`, and `emitInput`. Each complete
method body is wrapped in a runner-local depth increment and `try/finally`
decrement. Nested/concurrent emissions cannot clear each other's fence. Original
handler order, results, error swallowing, early cancel/handled returns and thrown
`emitToolCall` errors remain unchanged. Synchronous `emitError` only notifies
listeners and is not independently guarded (notifications inside an emitter are
still within its depth). The new 0.85.1 `after_provider_response` SDK hook also
delegates to guarded generic `emit`. The standalone `emitSessionShutdownEvent`
helper delegates to guarded `emit`. `emitProjectTrustEvent` has no runner, so it
uses a finally-safe depth on the shared extension runtime; even an unusually
captured, already-bound API rejects while that handler is awaited.

Awaited extension lifecycle callbacks are not admissible. This includes shutdown,
before-switch/fork, compaction/tree, startup/reload, model changes and
resource/input/provider pipelines. Public calls reject while runner or project-trust
event dispatch is active; events themselves are not serialized or blocked. The
old runner is invalidated synchronously immediately after reload's guarded shutdown
and remains stale across settings/resource awaits, so there is no callable old-API
reload gap. This is not a scheduler, provenance check or session-wide action lock.
Synchronous renderers and `emitError` listeners are notification-only and remain
outside an independent fence; Familiar renderers do not perform owner commits.
Hosts must gate unrelated non-event session actions throughout a handler;
prompt/public overlap is explicitly permitted by core, and upstream prompt dispatch
neither checks nor acquires the event guard or public slot.

Do **not** queue slash text via `sendUserMessage(... followUp)` as a substitute.
In 0.85.1 it defaults to literal model-visible text. The `expandPromptTemplates`
opt-in dispatches before streaming queueing, is void on the extension facade,
and expands skills/templates too. It does not replace an awaited idle-only API.

UI availability and cancellation remain the handler's/mode's responsibility.
There is no timeout, cancellation injection, sandbox, or rollback. Fire-and-forget
work after handler completion is outside the slot lifetime. Admission cannot
prevent a handler from starting another run or misusing captured raw objects.

## Pre-resolution model bootstrap

`ExtensionAPI.registerModelBootstrap(handler)` is a narrow registration hook,
not a lifecycle escape hatch. Pi invokes registered handlers after async factories
finish and before model scope, CLI, restored-session, or configured-default
resolution. A request identifies its source and carries an exact provider/model
pair when Pi has one. Bare CLI model patterns deliberately omit `provider`, so an
extension cannot interpret them as permission to materialize an unbounded
catalogue. `list`, and `default` on a box with no configured default, carry no
identity at all and permit only an extension-owned bounded seed. The phase is
unconditional: every runtime asks, so an extension sees one request per runtime
and never has to guess whether Pi skipped it. Scope patterns (`--models`,
`enabledModels`) are patterns rather than identities and are deliberately not
part of the request; they still resolve normally against whatever is registered.
Handlers have no context/session actions; they may queue provider registrations,
which Pi flushes into `ModelRuntime` immediately after all awaited handlers.
Handler and registration errors become startup diagnostics and therefore fail
closed in non-interactive/worker modes — and, because Pi exits on any error
diagnostic, in interactive mode too. A handler that wants a missing row to
degrade to Pi's ordinary resolution must therefore decide that itself, as
Familiar's Tiamat extension does for a router outage. The same `createRuntime`
closure invokes the phase for initial startup and `/new`, `/resume`, fork, and
import replacement flows. Extensions never inspect argv or settings/session files.
Each runtime has its own `ModelRuntime`, loader and extension instances, so a
bootstrap registration cannot leak into a replaced runtime.

## 0.85.1 rebase assumptions and patch order

Upstream tag `v0.85.1` is the lightweight tag at
`d981de1229ef899957bbe968bc8dcda02a21f477`. Familiar applies exactly:

1. `invoke-command.patch` — awaited exact-name direct extension-command
   invocation and complete event/settled admission fences.
2. `runtime-control.patch` — atomic no-run owner commits, incrementally accounted
   persistence budget and writer quarantine, admitted-user continuation, and
   owner/session/leaf/idle, command/event and runtime-replacement fences.
3. `model-bootstrap.patch` — awaited provider-only materialization from the exact
   effective CLI/restored/default request before any initial model resolution.

Neither facility exists upstream in 0.85.1, so no downstream portion was
superseded. The rebase preserves the changed upstream loader factory/runtime
ownership, session-runtime replacement bodies, SDK construction, prompt body,
SessionManager loading/appending and compaction flow. The command patch only
wraps the 11 awaited runner emitter bodies and hash-checks each body after
removing that one indentation level. Runtime control uses narrow admission
bindings at session/runtime ownership boundaries; replacement methods are
wrapped from public entry through completion so cancelled and failed
replacements are fenced too. Runtime-control entry IDs use upstream `generateId`
with a batch-local collision set. Synchronous `entry_appended` notifications stay
inside a commit-depth fence and cannot recursively commit.

Upstream commit `56700d42ed65a94a80af7376adb19a9298065164` (PR #8782,
issue #6879), included in 0.85.1, moved next-turn preparation into the continuing
agent loop. This allows threshold compaction after a large tool result and before
the next provider request in the same run. Familiar does not patch this path.
Upstream republishes `agent.state.model` and `agent.state.thinkingLevel` after
compaction, preserving the effective thinking level. Familiar therefore carries
no generic reasoning-level patch. The custom handoff's direct
`ModelRegistry.complete()` path remains separate: it retries with `low` only for
an explicit provider rejection of no reasoning and retains dedicated tests.

## Fail-closed update procedure

Inspected nixpkgs `pkgs/by-name/pi/pi-coding-agent/package.nix`: it builds the
GitHub monorepo (not the published coding-agent tarball), uses tsgo for workspace
deps, restores the model catalogue from matching npm pi-ai, then installs compiled
coding-agent output at `lib/node_modules/pi-monorepo`.

Evaluation asserts the expected locked nixpkgs 0.84.1 base recipe and its source,
then replaces it with exact **0.85.1** commit/source/vendor/model-data metadata.
It also asserts absence of nixpkgs patches or a prePatch hook. Before applying
any downstream patch, SHA-256 checks cover whole `loader.ts`, `runner.ts`,
`types.ts`, `agent-session.ts`, `session-manager.ts`, `agent-session-runtime.ts`,
`sdk.ts`, compaction and agent-loop sources, root/coding-agent manifests, lockfile,
and patched extension API docs. Separate hashes pin `extensions/index.ts`,
`agent-session-services.ts`, and `main.ts` for bootstrap registration exports,
provider flushing, exact request precedence, and pre-scope invocation. This pins command resolution, context construction,
prompt dispatch, SDK session construction, getCommands binding, replacement,
persistence and mid-run compaction internals—not merely nearby patch context.
Source rearrangements fail before patch application; patch fuzz is not the
verification mechanism. `invoke-command-shape.test.mjs` additionally checks the separate admission
binding, settled depth/finally, unchanged owning-session getter and default context
idle semantics, prompt-before-streaming ordering, direct prompt handler path,
public-only exclusive guard, and absence of a public bypass/legacy alias. A new
SHA-256 assertion pins the restored `_tryExecuteExtensionCommand` method byte-for-byte
to upstream, including its error runner selection and context creation. The entire
`prompt` section is also hash-pinned. Shape checks enumerate all async runner
methods, require complete finally-safe wrappers on all 11 emitters, reject dispatch
sites outside them, and hash each unwrapped body against pristine upstream (only
the added indentation is removed). Full pristine file hashes remain unchanged.

On an upstream bump, inspect the new source and nixpkgs build recipe, revisit
semantics and tests, and only then regenerate hashes/patch. Do not merely relax
assertions or refresh checksums to make a build green.

## Tests and validation

`invoke-command.test.mjs` imports the **compiled** loader, runner and AgentSession.
It exercises factory registration, real session getCommands binding, args/defaults,
suffix resolution, async completion through an explicit barrier, unknown/non-extension
names, sync Error identity and async non-Error normalization, self-invocation and
A → B exclusion, same/different-name concurrency rejection, busy public/event/tool
rejection, guard cleanup, real `_emitAgentSettled` execution where ctx.isIdle is
true but invocation rejects without running the target (including across an await),
settled dispatch failure cleanup and synchronous listener-tail rejection, real
`AgentSession.reload()` shutdown rejection with settings/resource I/O stubbed,
before-switch/fork cancellation, every non-generic emitter, normal/early/throw
cleanup, nested/concurrent event depth, real `AgentSession.prompt()` execution while busy,
prompt/public overlap in both directions, prompt error reporting, and stale API/
context behavior during and after replacement/reload. Session/resource I/O is stubbed
at the mode-action boundary; these are not full TUI or disk-backed lifecycle tests.

`model-bootstrap-shape.test.mjs` asserts that the callback is extension-owned,
awaited, flushed before CLI/scope resolution, unconditional, and does not read
`process.argv`.
`model-bootstrap.test.mjs` runs against compiled and installed output and proves
arbitrary restored/default identities, a bounded one-model seed for identity-less
requests, and no provider expansion for a bare CLI pattern.
`model-bootstrap-cli.test.mjs` drives the real installed `dist/cli.js` and asserts
the exact request Pi delivers for `--provider/--model`, no default, a configured
default and `--list-models`, plus that the seeded provider actually appears in
`--list-models` output.

Familiar's own `test/pi-tiamat-bootstrap.mjs` (repository root, run in the `pi`
dev shell) is the end-to-end counterpart: the installed patched CLI, the real
Tiamat extension and a stub router process on loopback, covering exact CLI,
canonical `route/model`, configured default, resumed session, bounded seed, bare
pattern, and router outage.

Source shape checks run in `postPatch`. Runtime tests run in `checkPhase` and again
unconditionally in `postInstall` against the installed runtime, plus installed
declaration assertions. The runtime test also checks incremental load/append and
exact-boundary accounting, 8-hex collision-safe control IDs, project-trust and
entry-notification reentrancy fences, and admitted continuation without a provider
call: model/auth readiness, disabled compaction, unchanged leaf, no duplicate user
append, `agent.continue()` rather than `prompt()`, and one settled event. `mid-turn-compaction.test.mjs` verifies in both source and
compiled output that 0.85.1's `prepareNextTurn` compaction path runs before the
next assistant request and republishes the effective model/thinking level. Setting
`doCheck` or `doInstallCheck` false cannot silently skip installed validation.
No provider call, operator state, or resident Presence is used.

For the 0.85.1 integration, run the following on x86_64-linux. The all-systems
Darwin limitation remains the unrelated gateway output that references a missing
viewer package. Non-native patched outputs are evaluation gates, not native builds.

Commands used from the repository root (x86_64-linux):

```sh
nix build .#pi-coding-agent --no-link -L
nix build .#checks.x86_64-linux.pi-invoke-command .#checks.x86_64-linux.drop-serve-lifecycle --no-link -L
nix flake check --no-build
nix flake check -L
nix eval --raw .#checks.aarch64-linux.pi-invoke-command.drvPath
nix eval --raw .#checks.aarch64-darwin.pi-invoke-command.drvPath
nix develop .#pi -c /nix/store/glcp73hgagq2b24i80jlgbvj28vdb6kk-nodejs-24.19.0/bin/node test/extension-loader-smoke.mjs
nix develop .#pi -c /nix/store/glcp73hgagq2b24i80jlgbvj28vdb6kk-nodejs-24.19.0/bin/node test/pi-tiamat-bootstrap.mjs
nix develop .#pi -c bash -c 'bash test/pi-extra-extensions.test.sh && bash test/pi-model-store.test.sh'
nix develop .#agents -c bun test integrations/pi/extensions/tiamat
```

The existing pi shell does not put Node on PATH; the smoke command explicitly uses
the locked package's Node interpreter. `nix flake check --no-build --all-systems`
was also attempted: it fails in the existing gateway Darwin output referencing
missing `viewer.packages.aarch64-darwin`, unrelated to this patch. Both non-native
patched checks evaluate successfully; only x86_64-linux was built here.

Negative verification (both must fail loudly):

```sh
nix eval --impure --expr 'let f = builtins.getFlake (toString ./.); p = f.inputs.nixpkgs.legacyPackages.x86_64-linux; in (import ./nix/patches/pi-coding-agent { pkgs = p // { pi-coding-agent = p.pi-coding-agent.overrideAttrs { version = "unexpected-base"; }; }; }).drvPath'
nix build --no-link --impure --expr 'let f = builtins.getFlake (toString ./.); in f.packages.x86_64-linux.pi-coding-agent.overrideAttrs { postUnpack = "echo tampered >> source/packages/coding-agent/src/core/agent-session.ts"; }'
```

The former rejected the version at evaluation; the latter rejected the modified
source checksum in prePatch before patch application.

Also built with both optional check flags disabled; installed validation still ran
and passed:

```sh
nix build --no-link -L --impure --expr 'let f = builtins.getFlake (toString ./.); in f.packages.x86_64-linux.pi-coding-agent.overrideAttrs { doCheck = false; doInstallCheck = false; }'
```
