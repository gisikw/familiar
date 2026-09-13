# Familiar Agents: admission preflight and profile provisioning

Architecture note for the simplification of native Agents admission around the
actual authority model. Companion to `familiar-agents-v1.md`.

## The governing requirement

> A remote preflight check should be:
> - Do you have this project and/or can you reach it?
> - Do you have the harness I asked you to run against it?
> ...that's it.

## What was wrong

Until `c6303e8`, every `plan` and `provision` request to the enrolled machine
carried a ~50 KiB "profile bundle": five TypeScript files read from the
controller's extensions tree. `remote.py` hard-coded the exact five filenames
(`BUNDLE_NAMES`) and refused any other set during the **read-only plan**. When
`tiamat/materializer.ts` was legitimately added, the controller shipped five
files against a four-name allowlist and every `familiar-tiamat-v1` dispatch
failed with the collapsed message `Remote read-only admission checks failed`.
The live fixes (`cc34285`, `c6303e8`) re-synchronised the mirror and added a
test that the mirror stays in sync; they did not remove the mirror.

That allowlist was described as a "credential-free source-only guarantee". It
was not one. The enrolled account is documented as *arbitrary shell at the
enrolled account effective authority; not a sandbox*: any content inside an
allowed filename executes with that authority, so an exact-filename check on the
remote constrains nothing. It was mirrored implementation knowledge — the
controller's current module graph, restated by hand on the other side of an
SSH pipe — and it coupled conceptual admission ("can this job run here?") to a
delivery detail ("which files does this controller version ship?").

## The design now

### Local admission (controller, unchanged in scope)

`imp agent dispatch` validates request schema and bounds, exact machine /
`pi` harness / enrolled model, and the per-route per-node availability policy,
all before any ledger write or remote contact. For a generated profile the
admission record also pins `profile_digest`, the SHA-256 of the artifact this
resident would install, so a later provisioning attempt by a different
controller build cannot silently substitute other code.

### Remote read-only preflight (`plan`)

Exactly two substantive questions, each with typed, specific failures:

| Question | Check | Refusal code |
|---|---|---|
| Project reachable | `git -C <repo> rev-parse --git-dir` | `repository_unavailable` |
| Ref resolvable | `git rev-parse --verify --end-of-options <ref>^{commit}` | `ref_unresolvable` |
| Harness launcher | pinned Herdr binary reports `herdr 0.9.0` | `herdr_unavailable` |
| Harness executable | account's own shell, `-lc 'command -v -- pi'`, started fresh with the enrolled `worker_env.PATH` | `harness_unavailable` |
| Enrolled profile (enrolled mode only) | `<profile>/settings.json` is a file | `profile_unavailable` |

Anything else that makes a plan fail to complete without mutating anything
(request shape, bounds, a non-absolute XDG root) is `request_rejected`: a
controller/remote contract mismatch, explicitly *not* a project or harness
verdict. A hung git or shell is a `TimeoutExpired` and stays an unknown,
retryable transport outcome. The plan request carries no source, digest or
model guard and is a few hundred bytes plus the enrolled paths; its result
carries the remote paths and the pinned commit only.

Exactly one fixed code crosses the SSH boundary on refusal: never stderr, an
exception message, a path or any remote output. The owner maps the code to a
specific message, records it as `admission_failure`, marks `failed_admission`
and emits one worklist notice. Unknown or decorated codes are not a refusal.
A route that fails before the machine answers is recorded as "Remote
preflight did not complete … project and harness were not evaluated; retrying"
rather than the generic observation error.

The harness check is an *availability* answer, not provenance. It starts the
account's shell the way a Herdr pane starts (fresh, with the enrolled worker
PATH, without an inherited NixOS `__NIXOS_SET_ENVIRONMENT_DONE` marker so the
node's own initialisation runs and may replace that PATH, exactly as it does
for a pane). It cannot prove *which* `pi` a pane will run; the launch-pending
observation remains the truth for that. It exists because the owner asked
"do you have the harness?", and because a `harness_unavailable` answer at
dispatch is far cheaper than a 60-second launch-pending grace and a stranded
Herdr name.

### Provisioning (mutating, unchanged semantics)

Provisioning still runs under the per-job lock with the retirement marker,
pins the initial commit, installs the pinned Herdr integration and the model
guard, and creates the detached worktree. For generated profiles it now
carries **one content-addressed artifact**:

```json
{ "extension": "tiamat", "files": { "tiamat/index.ts": "…", "lib/debug.ts": "…" } }
```

The controller derives `files` by walking relative imports from
`tiamat/index.ts` inside its own extensions tree (`workerProfileArtifact()`).
Adding, renaming or removing a module changes the artifact and its digest by
construction; there is no list to forget. Only regular `.ts` files inside the
tree are admissible (no symlinks, no `../` escapes, no `.json`), which is where
credential exclusion actually lives — at the controller source, not on the
remote.

The walk must never *silently* omit a runtime dependency: an omitted module is
a worker Pi that cannot load its extension, which is the same class of incident
as the retired filename allowlist. So every relative specifier it meets must be
a literal `.ts` path it can follow — `import`/`export … from`, side-effect
`import`, static `import()` and `require()` all count — and any form it cannot
resolve (interpolated template, `.js` or extensionless specifier, `.json`) is
refused by name. Symmetrically, a derivation defect is a *generated-profile*
defect only: it is raised when such a machine is dispatched and never disables
Agents for enrolled-profile machines, which ship no artifact at all.

The remote validates the artifact by **generic** rules only, identically to the
controller (`profileArtifact()` in `contract.mjs`, `artifact_digest()` in
`remote.py`, cross-checked by `test_remote.py` against the same vectors):

* 1–32 files, each path ≤ 6 segments, each segment
  `[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}` (so no `.`, `..`, hidden, empty,
  absolute or backslash segments), no NUL in content, no path that is also
  a directory of another, total ≤ 64 KiB;
* `extension` is a safe relative directory and `<extension>/index.ts` exists;
* the digest is language-neutral — SHA-256 over `extension\0` then each sorted
  `name\0content\0` — and must equal the admission-pinned `profile_digest`.

A rejected or mismatched artifact is refused with `profile_artifact_rejected`
**before** any lock, directory or marker exists; the owner treats it exactly like
a typed preflight refusal. Files are written atomically under
`<job>/profile/assets/<path>` with the same edit-refusal as before; the
generated `settings.json` points Pi at `assets/<extension>`.

What did not change: fail-before-uncontrolled-mutation, the recorded-XDG rule,
lock/retirement fencing, dirty-worktree refusal, cleanup of the generated
profile with the job, the 128 KiB native request bound, the model guard, and
exact enrollment/policy checks.

## What this deliberately does not do

* No sandbox is invented. Nothing on the remote can constrain what an admitted
  job does at the enrolled account's authority, so nothing pretends to.
* No new remote-side knowledge of the controller's module graph.
* No new deployment artifact, build step or package. A prebuilt single-file
  bundle was considered; it would add a build tool to the resident's dispatch
  path (or to Nix) for no security gain, when the node can simply own the
  extension (below).

## Migration and activation boundary

* Code activation is the next Presence birth. Nothing here restarts Presence,
  deploys or dispatches.
* Ledger schema is unchanged (v1). Existing records load as before;
  `profile_digest` on a job is now pinned at admission (null for enrolled
  profiles) and `admission_failure` is a new optional field in the projection.
* A `familiar-tiamat-v1` job admitted **before** activation and still in phase
  `provision` carries the retired `profile_bundle` and cannot be provisioned by
  the new controller. It is not silently retried: the owner records "This job
  was admitted with the retired five-file profile bundle protocol; abandon it
  and dispatch again with a new key." Jobs already past provisioning are
  unaffected (the artifact is only used to create the profile). The incident
  dispatches themselves ended in the terminal `failed_admission` state; before
  activation, check `imp agent status` for any generated-profile job still in
  phase `provision` and abandon/redispatch it afterwards.
* Typed refusals replace the single `remote_preflight_failed` code. An old
  controller talking to a new `remote.py` is impossible: the script is sent
  inline with every call, so both sides are always the same commit.

## Worker package / Fort, or only the resident controller?

**Only the resident controller changes.** `remote.py` has no installed copy on
any node; it travels with each SSH call. No Fort profile, worker package, Drover
node configuration, Herdr build or enrollment file needs to change for this
work, and no live dispatch or deploy is required to land it.

Recommended follow-up (not done here, and not required for correctness): the
cleanest end state is for the node's own runtime — the same Fort-tracked
profile that supplies `pi` to every Herdr pane — to supply the Tiamat extension
too. Then `profile_mode: "enrolled"` with a node-owned profile would serve
every machine and the generated-profile artifact path (and its 50 KiB per job in
the ledger) could be retired entirely. That is a Fort/worker-package decision
with its own release cadence; this change keeps the generated mode working
and honest until it is made.

## Concurrent live diagnosis (`job-8bb0cab9db6f296ab8438d98d5c40f86`)

That job investigates a detached-ref invocation on a live node. This work does
not depend on its result. To make the two failure classes separable:

* `test_remote.py::test_detached_linked_checkout_and_branch_refs_resolve_and_provision`
  proves on a real repository that a same-host **tracked checkout** (a linked
  worktree, detached at a commit) is a valid project path, that `HEAD`, a
  branch name, `refs/heads/<name>`, a full and an abbreviated commit id all
  resolve to the expected pinned commit from either checkout, and that a job
  provisioned from the detached checkout creates and cleans its own worktree
  without moving the tracked checkout.
* A ref that does not resolve is now reported as `ref_unresolvable`, distinct
  from `repository_unavailable` and from every harness code. If the live
  failure was the retired five-file mirror it presents as the old collapsed
  message; if it is a genuine ref/invocation defect it presents as
  `ref_unresolvable` (or as a `request_rejected` if the request shape is at
  fault) under this code, and the tests above bound what "ref" can mean.
