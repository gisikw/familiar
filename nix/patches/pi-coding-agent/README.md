# Familiar's downstream Pi patch (no fork)

This directory owns the Nix adaptation of **earendil-works/pi v1.5.0** used
by the top-level locked nixpkgs. It is not an extension and does not belong in
`integrations/pi`. There is no replacement source checkout or maintained git fork.
`default.nix` adapts the locked nixpkgs 0.84.1 recipe to immutable upstream commit
`f9a26365568127461c47a07a37dcb42c140a3ac5` (tag `v1.5.0`), including the exact
1.5.0 source, npm dependency, model-data, workspace-build and install metadata,
taken from nixpkgs' own 1.5.0 recipe: `npm run build:offline` (upstream's root
workspace order: telemetry, schema, chord, tui, codemode, mcp, ai, durable, env,
agent, coding-agent, plus the bundled CLI) and runtime copies of the codemode,
durable, env and mcp workspaces. Familiar also copies `pi-schema`, which pi-ai
imports at runtime and nixpkgs' list omits (its CLI bundle hides that; the
installed-output tests load the unbundled packages). The nixpkgs
wrappers, install checks and platform cleanup remain in force. The 1.0.0 Darwin
seccomp cleanup is kept as a harmless no-op (1.5.0 dropped the sandbox
dependency); Darwin derivation inspection is part of the release check.
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

We are pinned to verified **1.5.0**. Its owning-session `isIdle` is backed by
`_isAgentRunActive` and `isCompacting`; the former spans the run and post-run
retries/continuations, rather than only `agent.state.isStreaming`. This is the
upstream lifecycle predicate, not a new quiescence implementation. Because `_emitAgentSettled` clears that flag before
awaiting handlers, the separate session-owned dispatch depth fences that interval
without changing `ctx.isIdle()` (which is true inside `agent_settled`). Since 0.87,
runs requested from `agent_settled` handlers (`prompt()`, triggered custom
messages) are deferred until all settled handlers finish and then run inside
`_emitAgentSettled`. The depth wraps the complete pristine method body, so it
spans handlers, synchronous session listeners, and those deferred actions; it is
released in `finally` synchronously after upstream's idle-waiter resolution, so
waiters resume (in later microtasks) with admission restored. Admission
checks both synchronously, plus runner event dispatch depth, before acquiring the
public-only exclusive slot.

An exhaustive 1.0.0 runner audit found 13 awaited handler-dispatching methods:
`emitBoundary` (0.87: actionable `turn_end`/`agent_before_settle`, no longer
routed through `emit`; it also awaits the session's boundary-context builder),
`emit`, `emitCacheWarmingDecision` (0.86), `emitMessageEnd`, `emitToolResult`,
`emitToolCall`, `emitUserBash`, `emitContext` (now both the `context` and
`context_with_system` phases), `emitBeforeProviderRequest`,
`emitBeforeProviderHeaders`, `emitBeforeAgentStart`, `emitResourcesDiscover`, and
`emitInput`. Each complete
method body is wrapped in a runner-local depth increment and `try/finally`
decrement. Nested/concurrent emissions cannot clear each other's fence. Original
handler order, results, error swallowing, early cancel/handled returns, thrown
`emitToolCall` errors and 0.86's fail-closed `emitUserBash` rethrow remain unchanged. Synchronous `emitError` only notifies
listeners and is not independently guarded (notifications inside an emitter are
still within its depth). The `after_provider_response` and `provider_stream_event`
SDK hooks delegate to guarded generic `emit`. The standalone `emitSessionShutdownEvent`
helper delegates to guarded `emit`. The standalone `emitProjectTrustEvent` is not
wrapped (an earlier revision of this README claimed a runtime-level depth there;
no shipped patch implemented it). It only runs on the pre-trust extension set
that `DefaultResourceLoader` loads before any runner binds that runtime, so the
public API there is still the unbound runtime stub and rejects as not initialized.

Awaited extension lifecycle callbacks are not admissible. This includes shutdown,
before-switch/fork, compaction/tree, startup/reload, model changes and
resource/input/provider pipelines. Public calls reject while runner event dispatch is
active; events themselves are not serialized or blocked. The
old runner is invalidated synchronously immediately after reload's guarded shutdown
and remains stale across settings/resource awaits, so there is no callable old-API
reload gap. This is not a scheduler, provenance check or session-wide action lock.
Synchronous renderers and `emitError` listeners are notification-only and remain
outside an independent fence; Familiar renderers do not perform owner commits.
Hosts must gate unrelated non-event session actions throughout a handler;
prompt/public overlap is explicitly permitted by core, and upstream prompt dispatch
neither checks nor acquires the event guard or public slot.

Do **not** queue slash text via `sendUserMessage(... followUp)` as a substitute.
In 1.0.0 it defaults to literal model-visible text. The `expandPromptTemplates`
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

## 1.0.0 rebase assumptions and patch order

Upstream tag `v1.5.0` is commit
`f9a26365568127461c47a07a37dcb42c140a3ac5`. Familiar applies exactly:

1. `invoke-command.patch` — awaited exact-name direct extension-command
   invocation and complete event/settled admission fences.
2. `model-bootstrap.patch` — awaited provider-only materialization from the exact
   effective CLI/restored/default request before any initial model resolution.

`cache-write-1h-delta.patch` (Oct 22) is retired: upstream pi-ai reads
`usage.cache_creation.ephemeral_1h_input_tokens` from `message_delta` itself (it
was already there by 1.1.0; added for Vercel AI Gateway), which is exactly what
tiamat's facade needs. `cache-write-1h-delta.test.mjs` still runs against the
installed output, so a regression upstream fails the build.

Neither remaining facility exists upstream in 1.5.0, so no other downstream
portion was superseded. The rebase preserves the changed upstream loader factory/runtime
ownership, session-runtime replacement bodies, SDK construction, prompt body,
SessionManager loading/appending and compaction flow. The command patch only
wraps the 13 awaited runner emitter bodies and the `_emitAgentSettled` body and
hash-checks each body after removing that one indentation level. The bootstrap
patch's shared provider flush now also drains 0.99's queued virtual-model
registrations. Its `session` request still reports
`SessionManager.buildSessionContext().model` (the latest model change or
assistant model); 0.99's SDK restore prefers a recorded *virtual* model over the
physical model that answered, which no Familiar extension registers.
Upstream commit `56700d42ed65a94a80af7376adb19a9298065164` (PR #8782,
issue #6879), included since 0.85.1, moved next-turn preparation into the continuing
agent loop. This allows threshold compaction after a large tool result and before
the next provider request in the same run. Familiar does not patch this path.
Upstream republishes `agent.state.model` and `agent.state.thinkingLevel` after
compaction, preserving the effective thinking level. Familiar therefore carries
no generic reasoning-level patch. The custom handoff's direct
`ModelRegistry.complete()` path remains separate: it retries with `low` only for
an explicit provider rejection of no reasoning and retains dedicated tests.

## Fail-closed update procedure

Inspected nixpkgs `pkgs/by-name/pi/pi-coding-agent/package.nix`: it builds the
GitHub monorepo (not the published coding-agent tarball), builds workspaces with
upstream's `build:offline` script (TypeScript 7, formerly tsgo), restores the model catalogue from matching npm pi-ai, then installs compiled
coding-agent output at `lib/node_modules/pi-monorepo`.

Evaluation asserts the expected locked nixpkgs 0.84.1 base recipe and its source,
then replaces it with exact **1.5.0** commit/source/vendor/model-data metadata.
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
binding, settled depth/finally around the hash-pinned pristine `_emitAgentSettled`
body (including deferred settled actions), unchanged owning-session getter and default context
idle semantics, prompt-before-streaming ordering, direct prompt handler path,
public-only exclusive guard, and absence of a public bypass/legacy alias. A new
SHA-256 assertion pins the restored `_tryExecuteExtensionCommand` method byte-for-byte
to upstream, including its error runner selection and context creation. The entire
`prompt` section is also hash-pinned. Shape checks enumerate all async runner
methods, require complete finally-safe wrappers on all 13 emitters, reject dispatch
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
before-switch/fork cancellation, every non-generic emitter (including `emitBoundary`
for `turn_end`/`agent_before_settle`, `context_with_system` and
`emitCacheWarmingDecision`), 0.87 deferred settled runs (a deferred `prompt()`
command rejects public invocation; an idle waiter's continuation is admitted; a
failing deferred action still releases the fence), normal/early/throw
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
declaration assertions. (Earlier revisions of this README also listed
runtime-control checks — incremental load/append accounting, control IDs,
project-trust/entry-notification fences, admitted continuation — that belonged to
the since-removed background runtime patch; the shipped tests do not contain
them.) `mid-turn-compaction.test.mjs` verifies in both source and
compiled output that 1.0.0's `prepareNextTurn` compaction path runs before the
next assistant request and republishes the effective model/thinking level. Setting
`doCheck` or `doInstallCheck` false cannot silently skip installed validation.
No provider call, operator state, or resident Presence is used.

For the 1.0.0 integration, run the following on x86_64-linux. The all-systems
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
nix develop .#pi -c nix shell nixpkgs#bun -c bun test integrations/pi/extensions
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

## 1.0.0 → 1.1.0 true-up (Oct 10, 2026)

Rebased both patches from `v1.0.0` onto `v1.1.0` (`abe508e1`). `model-bootstrap`
rebased cleanly. `invoke-command` conflicted only in `_emitAgentSettled`, where
1.1.0 added `aborted` to `agent_settled` (upstream #10607); the depth fence now
wraps the 1.1.0 body, verified byte-identical after de-indentation (shape-test
pin `8ef403a6…`, re-reviewed). All 13 pinned runner emitters are unchanged in
1.1.0; `session-manager.ts`, `agent-session-runtime.ts`,
`agent-session-services.ts` and `compaction.ts` are byte-identical to 1.0.0.
The nixpkgs base (0.84.1 recipe) is unchanged. Recipe notes above that say
"1.0.0" about the build recipe still apply: the 1.0.0 recipe builds 1.1.0
unchanged (new src/npmDeps/modelData hashes only; flake checks green).

## 1.1.0 → 1.5.0 true-up (Nov 9, 2026)

Rebased the branch onto main (which had added `cache-write-1h-delta.patch`, the
mid-turn compaction check and the identity wire guard since Oct 3), then moved
both patches from `v1.1.0` onto `v1.5.0` (`f9a26365`). Hashes for src, npmDeps
and modelData are nixpkgs master's own 1.5.0 recipe; the build reproduced them.

- **`model-bootstrap`** applied with offsets only.
- **`invoke-command`** failed one hunk: 1.2 changed
  `emitBeforeAgentStart(prompt, images, options)` to
  `emitBeforeAgentStart(trigger, options)` (a `messageType: "user" | "custom"`
  union). The depth fence was re-applied around the new pristine body; it is the
  only one of the 13 pinned emitters whose body changed (diffed 1.1.0 vs 1.5.0;
  the other 12 are byte-identical), re-pinned `bedb6850…`. The `prompt()` pin is
  re-pinned `b9c18c3d…`: 1.2 moved the run setup out of `prompt()` into a shared
  `_startRun(trigger)`, still after `_tryExecuteExtensionCommand` and before the
  streaming check, which is what the fence relies on. `_tryExecuteExtensionCommand`
  and `_emitAgentSettled` are byte-identical to 1.1.0 (pins unchanged). Since 1.2
  a run counts as busy while it starts (including `before_agent_start`), which only
  narrows command admission further. The extension-docs hunk moved below the
  restructured docs ("Familiar downstream" section before *State Management*).
- **`cache-write-1h-delta`** retired (see above).
- Behavior change to know about: since 1.2, `before_agent_start` also fires for
  `pi.sendMessage(..., { triggerTurn: true })` runs (`messageType: "custom"`).
  Familiar's handlers: identity now covers woken runs natively (its
  `context_with_system` projection and the 0.85.1 wire guard stay as fallbacks);
  l1 and handoff key off their own input flags, so custom runs are no-ops for
  them; timegap will now add its time-awareness reminder to woken runs too.
- Pi's default prompt opening changed to "You are a coding assistant running
  inside pi"; the wire guard recognizes both openings.
- Workspaces: client, protocol and server are gone; durable, env and schema are
  copied at install.
- Test fixes: the invoke-command runtime test uses the trigger signature; the zip
  rewind disk test's fake `AgentSession` gets the two class fields `navigateTree`
  touches; identity parity/wire-guard tests accept the 1.5 wording and `<cwd>`.
- Also fixed on the way (was broken on main): the worker runtime never shipped
  `lib/system-payload.ts`, which `tiamat/system-prompt.ts` imports, and its check
  still expected only two patches.

Checks: `nix build .#pi-coding-agent` (shape, runtime and installed-output
tests), all seven flake checks, and the extension suite (`bun test` in
`integrations/pi/extensions`: 224/224 with `PI_PACKAGE_DIR`/`NODE_PATH` from the
patched package). `test/pi-extra-extensions.test.sh` and
`test/pi-model-store.test.sh` fail identically on main; not addressed here.
