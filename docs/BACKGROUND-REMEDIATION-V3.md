# Background Exo v3 — implementation and isolated release proof

## Bases, code and authority

This is the implementation continuation of the exact v2 heads:

- Familiar v2: `3d74b1afc2ac21097eefcde4d0860cd099f600de`, based on
  `47a5512748fe41f5d11406a4a51aba383c978b66`.
- familiar-ui v2: `3d481080b14119b7be7716ccf6fab2d4b85e5168`, based on
  `a958104892733d30aa89735fb6dd7f1e5e4fa270`.
- Familiar implementation: retained `d23f83c`, `35c5706`, `91cbefe`, completed by
  `cc453aeefaaf9d94d1556c7f4e193895973979d8`.
- Familiar baseline fixture repair: `5c2a4c6e88717661da5cb0c0de7f1c2ea770ddff`.
- UI implementation: retained `8798047`, completed by
  `e6d2b1f504d14831049c6bbb4fd8f58d15c50b7f`.

The operator explicitly selected **isolated new-birth acceptance**, not a hot
upgrade. No existing resident Presence, Pi or golemd was restarted or modified.
No Golem worktree was created. Original research/reviews remain in their sibling
worktrees; the rejected prototype was not loaded or cherry-picked. The v2
withholding documents remain historical records, not the current release result.

The child-storage boundary follows the operator's clarification: Background owns
local admission, references, reservations, cancellation intent and retention
requests. The child backend owns its worktrees/artifacts and any hard filesystem
quota. A shell-capable child cannot honestly be assigned a hard byte guarantee by
this in-process scheduler. Optional reported quota/high-water capabilities are
honored, not invented or treated as a waived defect.

## Implemented path

Read [the host contract](../packages/background/README.md) for the API, limits,
recovery and backend boundary.

The real path is now:

`browser composer / hands-free tool → Familiar-owned Pi extension → SQLite
intent + sealed seed → pinned canonical owner transaction → durable runtime
receipt → deferred independent SDK branch → owned child tools/subscription →
settled bounded report → one canonical model-visible merge → browser/TUI report`.

Admission does not infer in the foreground. Its atomic user/delegation-notice/
receipt group cannot tear. The hidden typed notice is model-visible so later
foreground reasoning knows the earlier request was delegated; it is not assistant
assent. Hands-free admission defaults to the existing current user entry and
mechanically suppresses sibling preparation tools. It does not duplicate that
entry or copy its own foreground tool call/results into the branch seed.

Branches have independent resource/model/session services, read-only file tools,
inalienable report/refusal/rejoin controls and branch-owned backend tools. No
recursive Background tool, ambient foreground Agents relay, UI or worklist is
loaded into them. Dispatch, questions, answers, steers, cancellation, artifact
review and integration references use the existing backend semantics. The
normalized adapter is replaceable by a Familiar Agents ledger.

Rejoin checks complete settlement, current report/run, reviewed terminal children,
parent session and current leaf. It persists the entire bounded packet in model
`content`. It rejects consumed/superseded packets, reconciles append-before-receipt
failures, and never silently reparents a changed session. Plain unstructured
returns are explicitly unverified bounded final-message fragments, not an
invented integration approval or a transcript dump.

The shipped Projects hierarchy and composer now include live workstreams,
blocked child questions and controls, bounded report inspection, backend storage
status, quarantine reconciliation, attachments and project-reference chips.
Full/compact/rail/mobile layouts, keyboard/focus and draft preservation are
covered. Browser projection strips internal archive paths and raw request bodies;
private classification takes precedence. Nothing was added to the old settings
Sidebar, and no demo workstreams appear in production.

## Pi 0.85.1 integration assumptions

The release candidate now pins lightweight upstream tag `v0.85.1` at immutable
commit `d981de1229ef899957bbe968bc8dcda02a21f477`. The verified Nix source hash is
`sha256-gU8BSiqqOYt2RRuQONHHGvZeSM5KFQVrwif9bmuUXUc=`, npm dependency hash is
`sha256-jzlsZIQzfl1FCZZ5//dHFWwMfBZQ4nRD6KB4HHifPqE=`, and restored pi-ai model
data hash is `sha256-r30RmGF5RFzm/oizfVfeIvgjwP/TplyuMcVVt/XpklM=`.

Patch order is deliberate: `invoke-command.patch` first, then
`runtime-control.patch`. Upstream 0.85.1 still has no equivalent direct awaited
extension-command API, atomic no-run owner transaction, admitted-turn continuation,
persistence budget/quarantine, or complete owner/replacement fence, so neither
patch was dropped. Both were rebased around upstream's changed loader, SDK,
session/runtime, model and compaction code while retaining upstream method bodies.

Upstream commit `56700d42ed65a94a80af7376adb19a9298065164` (PR #8782,
issue #6879) is an ancestor of the target. It runs threshold compaction after a
large tool result and before another assistant request in the same run, then
republishes the effective model and thinking level. Familiar asserts this in
source and installed output and adds no generic reasoning-level patch. The
custom handoff's direct `ModelRegistry.complete()` retry-at-low behavior remains
separate and tested.

## Acceptance evidence

| Gate                                            | Result                                                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installed pinned Pi 0.85.1                      | Exact commit/source/vendor hashes, unchanged upstream command/emitter bodies, installed JS/declarations and owner-control assertions passed             |
| Upstream mid-turn compaction                    | Source + compiled assertions prove threshold compaction precedes another assistant request and preserves effective thinking                            |
| Background core / compiled SDK                  | **147 passed**; one cross-repository case intentionally omitted from the standalone Nix closure and run separately                                    |
| Cross-repository production-extension HTTP flow | **1 passed**, no skip: canonical admission → actual SDK/report tool → durable refusal merge                                                           |
| Actual process-kill boundaries                  | **102 SIGKILL cases**: 60 retained kernel boundaries, 8 canonical primitive cases, 33 composed admission/rejoin/failure cases, 1 host-held lease case |
| Compiled SDK synthetic isolation                | Retained **100 cycles** with independent runtime/loader/session ownership                                                                             |
| Familiar extension + contrib                    | **240 passed** (178 extension + 62 contrib); real Node loader smoke loaded all 13 directory entrypoints without Bun globals                           |
| Familiar shell regression scripts               | **9 scripts passed**                                                                                                                                  |
| Presence isolated lifecycle                     | **12 passed**                                                                                                                                         |
| Native viewer                                   | **97 passed**, all targets                                                                                                                            |
| Gateway Bun suite                               | **75 passed** across 13 files                                                                                                                         |
| Subscriber + zip harness                        | Passed with synthetic attach and matching installed SDK resolution                                                                                    |
| Native gateway/viewer/Presence browser smoke    | **6 passed**; Kitty translation proven by APC bytes and **11,760 magenta pixels**                                                                     |
| familiar-ui npm check                           | **267 Node + 163 web passed**, type and format checks passed                                                                                          |
| Pinned Playwright 1.61.1                        | **55 passed, 7 intentional platform skips**; includes 14 Background cases using real isolated Familiar/Pi births                                      |
| Familiar and UI host-system Nix checks/builds   | Passed                                                                                                                                                |
| Redacted diff secret scans / whitespace checks  | Clean                                                                                                                                                 |

Browser cases prove attachment/image + bounded project-chip admission, next-turn
model visibility of the complete merge, explicit refusal, plain unstructured
return, two held SDK branches with foreground response, cancellation, SIGKILL and
rebirth without replay, session replacement, branch-local child questions,
answers, artifact review and integration references, hands-free sibling-tool
suppression, and the upload/leaf race with edited retry identity. The legacy
foreground Agents relay is loaded too: branch jobs do not populate its ownership,
pending/blocked or worklist fallback directories.

### Real-provider release gate (not synthetic concurrency)

`packages/background/real-presence-probe.mjs` uses the real Familiar launcher,
private tmux Presence, the production UI bridge and scheduler, and three sessions
inside **one isolated Pi process**. It discovers a valid model using the existing
Router catalog on the authorized provider/wire. It does not copy credentials,
print tokens/headers/request bodies, inspect resident history, or dump real-provider
panes. Unsupported-model/error records fail the gate even with HTTP 200.

The following real-provider result belongs to the accepted pre-upgrade Background
candidate and remains historical evidence for the probe itself. The 0.85.1
integration did not spend provider quota or treat this earlier run as upgrade
proof:

```json
{
  "proven": true,
  "model": "gpt-5.5",
  "residentBirth": "isolated",
  "canonicalAdmission": true,
  "admissionMs": [19, 63],
  "foregroundLatencyMs": 2264,
  "branchTextDeltas": [0, 0],
  "branchToolArgumentDeltas": [111, 116],
  "inProcessBranchSessions": 2,
  "samePiProcess": true,
  "cancelledAndDrained": true
}
```

The harmless tasks requested different bounded tutorials in the report tool.
Thus real **streamed tool-argument deltas**, not just plain text, prove background
inference progress. Both provider streams were still active when the foreground
completed. No synthetic child job was used by this gate. Both branches were then
cancelled/drained and the isolated instance was torn down. Earlier valid runs
also passed; the retained `d23f83c` bare-SDK probe is not used as a substitute.

## Failures that were repaired during implementation

- Real streaming was previously mistaken for successful inference at HTTP 200.
  The probes now discover the model and reject streamed errors.
- A normalized `integrationRef: null` could not be revalidated by the v2 report
  normalizer. Internal packet metadata could also invalidate a maximal accepted
  report at merge time. Both have exact-boundary regressions now.
- Admission-only custom metadata did not tell the foreground model that a user
  request was delegated. The atomic model-visible runtime notice fixes this
  without fabricating an assistant reply.
- Uploads previously recaptured a later leaf, and edited retries could resend an
  older cached admission. Submit-time fencing and payload-bound retry state fix
  both; browser tests advance the live leaf while an upload is held.
- A lease helper's death could release a live host's lock. The lock now belongs
  to the host-retained inherited file description, tested with SIGKILL.
- Child create/event races, lost detail reads, durable answer/steer/cancel intent,
  coalesced wake capacity and foreground-relay ownership were exercised/fixed.
- Token-rate UI projection used to reread full admission bodies. The committed
  immutable public cache and aggregate projection budget remove that path.
- Responsive remounts discarded steering drafts; bounded parent-scoped workbench
  state now preserves drafts and in-flight controls.
- The native viewer smoke still expected pre-theme teal pixels; it now checks the
  actual canonical PNG accent without weakening the spatial/pixel threshold.
  Its login-shell fixture also needed the explicit test-tool PATH for `kitten`.
- Test environments initially lacked `nc`, native `node-pty`, or consistent SDK
  module resolution. Tests were rerun in pinned shells with the proper native
  dependency build. A timer test now observes both bounded transitions rather
  than relying on a fixed sleep under parallel crash/fsync load.

## Production deployment / new birth — supervisor only

**Do not `/reload` this into the current resident.** The compiled canonical owner
API and complete paired UI must be present before a new birth. The commands below
are deployment instructions, not actions performed against production by this job.

1. Authenticate/fetch and reconcile both repositories against their remotes.
   Familiar remote HEAD was verified as
   `47a5512748fe41f5d11406a4a51aba383c978b66`; UI HTTPS authentication was unavailable,
   so its remote freshness remains unverified. Nothing was pushed.
2. Build the reconciled Familiar pinned Pi and UI closures and rerun the paired
   gates. Store paths vary with the complete repository source; the exact
   commit, pin/hashes and installed-output checks—not a copied store path—are
   the authority.
3. Stage the UI's `$uiOut/share/familiar-ui/web` using the existing hardened
   frontend/broker deployment. Replace the old UI extension entry with
   `$uiOut/share/familiar-ui/packages/extension/dist/index.js` in the instance's
   `FAMILIAR_PI_EXTRA_EXTENSIONS_JSON`. Preserve other authorized extensions;
   do **not** load two UI extensions or the rejected prototype.
4. For the new instance environment set:

   ```sh
   export FAMILIAR_BACKGROUND_ENABLE=1
   export FAMILIAR_BACKGROUND_STATE_DIR="$INSTANCE/state/background"
   # Keep the existing validated FAMILIAR_TIAMAT_*, GOLEM_ENDPOINT/auth,
   # FAMILIAR_UI_ORIGIN and private descriptor/attachment settings.
   # Optional, when backend usage is reported:
   # export FAMILIAR_BACKGROUND_CHILD_SOFT_BYTES=<positive-byte-threshold>
   ```

   Use the normal Familiar Tiamat provider adapter, or an explicitly reviewed
   `FAMILIAR_BACKGROUND_PROVIDER_EXTENSION` for another configured route. Do not
   embed credentials in source or JSON snippets. Confirm the selected model is
   actually usable, not merely advertised.

5. At an operator-approved maintenance boundary, let the foreground settle and
   drain/cancel any owned work. Stop **only the configured instance's** Presence
   using its own state directory/socket and `services/presence/presence.sh stop`.
   Confirm its old worker/Pi has exited. Do not use global `pkill` or touch golemd.
6. Point `FAMILIAR_REPO` at the reconciled Familiar release and run that release's
   `presence.sh ensure` with the same private instance configuration, or use the
   normal `familiar.sh connect` new-birth path. `familiar.sh pi` selects the pinned
   compiled package. A surviving instance must not be treated as a new birth.
7. Verify the fresh descriptor/epoch and Background capabilities, then perform a
   harmless admission/refusal/rejoin check. Confirm one canonical user/notice/
   receipt group, one complete merge, no extra foreground inference, and no
   branch jobs delivered to the foreground worklist.

Rollback is a **new-birth** operation: disable `FAMILIAR_BACKGROUND_ENABLE`, restore
the paired known-good deployment and start a fresh owner after the old one exits.
Retain the SQLite state and archives for review; do not delete locks/live state to
force capacity or reinterpret uncertain work as safe to replay.

## Operational boundaries

- Default resource budgets intentionally produce backpressure or quarantine.
  GC does not forget admission identities or evict an uncertain writer. Read-only
  SQLite inspectors must release transactions before the next mutation can
  truncate its journal. A full canonical/control budget requires inspection and
  deliberate continuity handling, not silent transcript rewriting.
- A timed-out/failed abort may keep capacity and the host lease until process
  death. Explicit quarantine release requires writer retirement and backend
  settlement proof; a missing backend create reference is not such proof.
- Providers/extensions are trusted code in one process. There is no hostile-code
  OS sandbox. Child worktree/artifact storage is backend-owned; hard per-child
  quotas remain optional OS/backend capabilities as specified by the operator.
- The tested resident-host platform is Linux. Browser desktop/mobile coverage
  does not claim a new native host port or a hot-upgrade mechanism.
