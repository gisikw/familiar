# Background Exo: resident-owner integration

Background runs inside a **Familiar-owned Pi birth**, not a second foreground Pi
process, transcript drop-box, or browser-side agent. Enable it only for a new,
validated birth with `FAMILIAR_BACKGROUND_ENABLE=1`. The current resident is not
hot-patched. See [release/deployment proof](../../docs/BACKGROUND-REMEDIATION-V3.md).
The v2 document is historical; its kernel remains the foundation of this host.

## Ownership and admission

`integrations/pi/extensions/background/index.ts` starts the host on a TUI
`session_start`, after acquiring its exclusive instance lease. `familiar.sh pi`
supplies a private `FAMILIAR_BACKGROUND_STATE_DIR`, defaulting to the instance's
`state/background`. Print/background sessions do not start another host or UI.
The Linux `flock` lock belongs to an open-file description retained by the Pi
process itself. Killing a helper cannot free a live writer's lease. The lock
inode is never unlinked; process death releases the descriptor.

Browser admission uses the ordinary durable attachment resolver and bounded
project-handoff encoder. It captures session/leaf **before uploading**. Retrying
an unchanged submission retains its identity and parent; editing it creates a
new submission. No slash command, prompt template, skill expansion, foreground
model inference, or assistant assent implements admission. Background treats
composed text as data; `#room` text does not invoke a foreground room switch.
Terminal-only `/private` remains excluded from browser command invocation.

The owner synchronously performs:

1. Validate the exact content, expected parent, idle/lifecycle state, model and
   resource reservations; take a bounded, non-mutating message-context snapshot.
2. Commit payload-bound admission intent in SQLite (`FULL` WAL transactions).
3. Write/fsync the independent branch seed, its directory and the owner root;
   commit its identity, initial digest, canonical reference and selected model.
4. Through the pinned Pi owner API, atomically commit the actual user entry (or
   reference the existing hands-free entry), a hidden **model-visible typed
   delegation notice**, and a public-identity-only runtime receipt. This is one
   bounded write/rename/fsync transaction, not two append calls. It never creates
   an assistant entry. The model-visible notice prevents the foreground from
   mistaking an unanswered delegated request for work it must repeat.
5. Commit the scheduling receipt, then defer runtime construction, registration
   and queue start. Neither factories nor model/tool work execute under admission.

SQLite records transactional scheduling intent; canonical Pi JSONL is the
conversation commit authority. These are **not** claimed to be a distributed
atomic transaction. Recovery reconciles the durable boundaries. Incomplete or
uncertain admissions are retained as orphaned records, never automatically
rerun. A durable user/notice/receipt group cannot be torn into a user-only prefix.

The hands-free `background` tool takes no preparation arguments and captures the
exact current user entry. It terminates the foreground batch and defers admission
until settlement. Sibling preparation tools in that batch are mechanically
blocked with terminating results. It does not duplicate the user entry or pass
its own tool call/results into the new branch seed.

## Pi and branch runtime

The downstream stack is pinned to exact **Pi 0.85.1** tag commit
`d981de1229ef899957bbe968bc8dcda02a21f477` with verified source/vendor hashes.
`invoke-command.patch` applies first; `runtime-control.patch` then adds
`commitRuntimeControl`, a non-mutating eligibility hint, `continueAdmittedTurn`,
and a per-session persistence budget. Control transactions reject stale
session/leaf, command/event/replacement/settled dispatch, pending messages,
compaction and bash work. The original 0.85.1 prompt/command and all wrapped
emitter bodies remain hash-checked beneath the admission fences. Source shape and
installed compiled output are tested unconditionally during Nix installation.
Upstream's included `56700d42` fix compacts after large tool results before the
next assistant request in a continuing run while preserving effective thinking;
Familiar asserts that path and does not patch generic reasoning behavior.

A post-rename persistence failure poisons that writer. It cannot append or start
another prompt; recovery requires a new owner reading the archive. Temporary
control files are bounded and reclaimed under the host lease on rebirth.

Each branch has its own SessionManager/file, ModelRuntime, resource loader,
settings and extension runtime. The selected model is captured at admission,
not reread from a later foreground model choice. Ambient extensions, UI,
subscriber, worklist, prompt templates and skills are not loaded into branches.
The audited provider extension is loaded independently (Familiar Tiamat by
default); another configured route requires a trusted provider adapter via
`FAMILIAR_BACKGROUND_PROVIDER_EXTENSION`. Credentials are not copied into code or
branch settings. There is no arbitrary extension list or shared mutable model
runtime.

Branches retain read-only file tools plus inalienable report/refuse/rejoin and
owned-child controls. They have no `background` fork tool, bash or direct write
workflow. Mutating/review/integration work is delegated through the configured
child backend's existing workspace semantics. Tool results and artifact reads
are bounded; artifact text is paged in 4 KiB chunks. `continueAdmittedTurn` runs
the seeded user entry through Pi's actual retry/queue/settled pipeline, without
appending it a second time. It fails closed unless the branch is idle with no
pending/custom/bash work, the exact user leaf and selected model remain stable,
authentication is ready, compaction is disabled, and no input/before-agent-start
preflight handlers are installed. Skipping those prompt-only hooks and pre-turn
compaction is deliberate for this already-admitted isolated branch; normal settled,
retry, queue and post-run event semantics still apply.

## Reports and rejoin

Reports have explicit progress, blocked, ready, failed, refused, narrowed and
returned dispositions. Questions, risks, decisions, durable context, changed
artifacts and integration references are preserved. A terminal plain-text return
without a structured report is returned as an explicitly **unverified** fragment
of that one final message (at most 4 KiB), with no invented integration approval.
It is not a transcript dump.

Only a valid current terminal/refusal packet can rejoin, after full Pi settlement,
queued-work completion and owned-child terminal/review fences. The canonical
session must still match. A changed leaf is compared against the current caller's
expectation; a deliberate delivery at a later leaf is marked `staleParent` in the
packet. A changed session is orphaned, not silently reparented.

The broker freezes rejoin intent, verifies/fsyncs/seals the archive, then commits
**one complete bounded custom message** in canonical Pi context and records its
delivery. All continuity fields are in `content`, not Pi-dropped `details`.
Replays and superseded reports reject. Append-before-receipt failures reconcile
by complete packet identity; a healthy owner can retry an undelivered intent.
Poisoned owners require rebirth. Automatic rejoin waits outside foreground work,
without polling/copying model context when there is no pending return.

The browser shows an attributed report, not internal archive paths or raw JSON.
The Projects hierarchy exposes full reports, questions and child references, with
steer/cancel/rejoin/inspect and quarantine reconciliation. Native TUI renderers
also distinguish runtime receipts and reports from assistant speech.

## Child backend boundary

`backend.mjs` is the normalized backend port; `background/backend.ts` is the only
legacy Golem dependency in the host/runtime binding. A Familiar Agents ledger
can replace that adapter without rewriting branch admission, scheduling or
ownership semantics. No Golem repository/service was changed for this feature.

Background owns direct child reservations, stable create references, answer and
steer/cancel intent, event consumption, review acknowledgement and report linkage.
The backend owns job lifecycle, actual workspace mutation, retries/resume
semantics, worktrees and artifacts. Create retries retain their key; non-idempotent
steers with uncertain outcomes are not automatically replayed. Cancellation uses
read-only create-key lookup for uncertain creates, never a new dispatch during
abort. Unknown outcomes retain their reservation until the backend proves them.

One Background-owned subscription coalesces invalidations by owned job and uses
an O(1) ownership index to reject foreign events. Detail-read failures retain the
pending event independently of the reconnect cursor. A post-create status read
covers events that raced the create receipt. Internal wakes have a separate
coalesced slot and cannot exhaust the ordinary steering quota. Questions and
settlements remain branch-local; the legacy foreground relay only claims jobs
recorded through its own dispatch path. Browser tests load that relay too and
prove branch jobs do not populate its worklist/drop-box.

Every child dispatch requests **14-day artifact retention**. Reported backend
usage, high-water/admission status and quota support are projected when present;
blocked/invalid/unavailable admission fails closed. An optional
`FAMILIAR_BACKGROUND_CHILD_SOFT_BYTES` threshold is honored when usage is reported.
There is **no claim of a hard per-child filesystem quota** for an arbitrary shell-
capable agent. That is an optional future OS/backend capability, not a missing
Background invariant. Background never deletes child worktrees/artifacts or an
active/uncertain writer. Existing operator tools retain their backend privileges.

## Enforced local policy

| Resource                                     | Bound / behavior                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live branch writers / pending constructions  | 4 total; uncertain writers retain capacity                                                                                                                   |
| Outstanding direct children, across branches | 4, including unresolved creates                                                                                                                              |
| Child references per branch                  | 32, even if earlier children already settled                                                                                                                 |
| Admission / context snapshot                 | 8 MiB / 16 MiB; progressive validation stops oversized traversal                                                                                             |
| Reports / report content                     | 32 reports per branch; normalized report ≤32 KiB                                                                                                             |
| Model-visible merge                          | ≤40 KiB, including provenance and archive reference                                                                                                          |
| Human steering / child steer receipts        | 32 durable identities each; individual content ≤32 KiB                                                                                                       |
| Internal child wake                          | One coalesced slot; latest events remain in bounded child metadata                                                                                           |
| Branch session file                          | 32 MiB; reject before publishing an over-budget append                                                                                                       |
| Canonical control transaction                | ≤32 MiB complete canonical file; at most one user, notice and receipt per batch                                                                              |
| Branch archive storage                       | 512 MiB aggregate; 64 MiB reservations for active/uncertain writers, actual bytes for sealed retired archives                                                |
| Local directory scan                         | At most 4096 entries; reject unsafe entries/symlinks                                                                                                         |
| SQLite                                       | 256 MiB page cap; one bounded-record transaction per mutation; WAL must truncate before the next mutation, so a held reader cannot cause accumulating growth |
| Records                                      | 256; admission tombstones are not forgotten by GC                                                                                                            |
| Turn / idle / retirement                     | 15 minutes / 60 minutes / 5-second retirement phase                                                                                                          |
| Runtime construction during shutdown         | Finite drain; uncertain construction remains quarantined                                                                                                     |
| Retention / GC                               | 14 days after terminal updates; only retired, settled archives; preserve identity/reference tombstones                                                       |
| Browser workstream projection                | Current session first, live/quarantine priority; ≤64 entries and ≤256 KiB aggregate                                                                          |
| Browser drafts / in-flight controls          | 64 scoped drafts, ≤32 KiB each; 64 in-flight controls; survive responsive remounts                                                                           |

Bounds cause backpressure, refusal or quarantine, not fabricated success. In
particular, a canonical file beyond the control budget cannot accept Background
transactions; ordinary foreground behavior is not silently rewritten to free
space. Never share an instance's Pi/state directories between independently
launched foreground owners. This is cooperative host/extension isolation, **not
an OS sandbox** for hostile plugins, providers or arbitrary operator shell code.

## Reproduction

Use the paired UI checkout, with its npm dependencies/build available:

```sh
nix build .#checks.x86_64-linux.background-core --no-link --no-update-lock-file
nix develop .#background -c bash -c '
  FAMILIAR_UI_SOURCE=/absolute/familiar-ui node --test packages/background/integrated-host.test.mjs
'
```

The standalone core check intentionally skips the cross-repository test when no
UI source is supplied. The release gate runs it separately, plus all browser
cases with `FAMILIAR_BACKGROUND_E2E_SOURCE` set. The `background` shell supplies
the installed pinned Pi, Node, Bun and the pinned browser closure.

```sh
# From familiar-ui/packages/web, inside Familiar's background shell:
FAMILIAR_BACKGROUND_E2E_SOURCE=/absolute/familiar ../../node_modules/.bin/playwright test

# Opt-in real gate, inside the same shell with the existing authorized Router env:
BACKGROUND_REAL_PROVIDER_PROBE=1 FAMILIAR_UI_SOURCE=/absolute/familiar-ui \
  node packages/background/real-presence-probe.mjs
```

`real-presence-probe.mjs` discovers the configured model on the authorized
provider/wire, starts an isolated real Familiar Presence, admits through the real
browser bridge, and requires foreground inference to finish while **both real
branch streams are still generating output**. Tool-argument deltas count as real
model output; HTTP 200 headers alone do not. Streamed errors fail the gate.
Prompts are bounded harmless tutorials. The probe verifies all three sessions
share the isolated Pi process, cancels/drains both branches, and tears down only
its own temporary instance. It does not read resident history or log credentials,
provider payloads or real-provider panes. The older bare-SDK probe remains as a
separate diagnostic, not a substitute for this release gate.
