# Background Exo remediation kernel (not enabled)

This is a **pre-integration host component**, not a Pi extension entrypoint or a
shippable Background action. Nothing discovers or starts it automatically. Do not
load the rejected prototype alongside it. Public runtime behavior changes in this
worktree are limited to Golem transport hardening and test-environment isolation.

## Implemented contracts

- `protocol.mjs`: byte-bounded, validated admission/report envelopes. Admission
  identity binds the exact content (including image data and attachment/handoff
  annotations), client-observed parent session/leaf, and project identity. No
  trimming, rewriting, or transcript serialization. Refusal, narrowing, failure,
  and immediate return are explicit dispositions.
- `store.mjs`: one SQLite transactional source of truth. Admission uniqueness,
  reports, child ownership, steering, generation changes, rejoin intent, and
  delivery receipts cannot diverge through secondary index writes. `FULL` WAL
  commits precede external effects. Recovery fences the **old** generation and
  never automatically reruns uncertain model/tool/child work.
- `scheduler.mjs`: synchronous durable acceptance; deferred per-branch execution.
  Neither steering nor cancellation returns the model/abort promise to a caller's
  foreground gate. Run-specific settlement, finite turn/idle/abort deadlines,
  shutdown draining, and quarantine of uncertain writers are explicit. A resolved
  `abort()` alone is insufficient: the executing turn must also finish before
  disposal. Rejoin-in-progress survives shutdown for canonical reconciliation.
- `children.mjs`: branch-bound adapter over the existing GolemClient API, **not**
  another Golem lifecycle engine. Records stable dispatch intent before HTTP;
  request retries reuse golemd's create key. Fetches authoritative job detail on
  SSE invalidation, rejects foreign/stale ownership, routes questions/answers,
  retains latest events until branch acknowledgement, and prevents rejoin before
  child review. No worklist drop-box or foreground fallback exists here.
- The complete bounded merge envelope, including provenance, disposition,
  decisions, durable context, risks, questions, integration ref and archive ref,
  is encoded in model-visible `content`, not only Pi-dropped `details`. Compiled
  Pi conversion tests verify this. It is attributed data, not assistant assent.

The scheduler's injected runtime must have unique session/file ownership and
resolve `run()` only at full Pi settlement, including retries and queued work.
Its `abort()` must include owned child cancellation/settlement. These are adapter
obligations, not guarantees supplied by the kernel. There is no OS sandbox here;
trusted host code and filesystem permissions are not a hostile-code boundary.

## Reproducible component tests

```sh
nix build .#checks.x86_64-linux.background-core --no-link --no-update-lock-file
```

The check uses the **installed compiled** Familiar-pinned Pi 0.84.1, including the
existing invoke-command patch. No new Pi patch is introduced. It covers:

- 60 real SIGKILLs: after write, before commit and after commit for each of 20
  store/scheduler/child persistence operations; reopen, dedupe and generation
  fencing follow every kill. These are process kills, not exception-only tests.
- Parent/payload/project conflicts; report conflicts and supersession; stale
  settlement; first rejoin/replay; append-before-receipt reconciliation contract;
  refusal/narrowing/return with explicit questions; image/handoff normalization;
  aggregate admission/report and active-record bounds.
- Two held branch turns with foreground-gate acceptance, nonblocking steering,
  slow abort, timeout quarantine, teardown and cancellation during child create.
- Branch-local child questions, answers, settlement/review and foreign rejection.
- 100 compiled SDK streaming cycles with three independent ModelRuntimes,
  loaders, settings, extension runtimes, managers and session files; foreground
  completes while both branches remain active; abort/disposal cannot redirect
  another session's extension writes or stop its stream.

The SDK endpoint is a local synthetic OpenAI-compatible streaming server. This
proves SDK concurrency and routing, **not real model inference or integrated
UI/host admission**. SIGKILL workers are small Node test processes, not Pi agents.
The test can be run without Pi by omitting `PI_PACKAGE_DIR`, but its Pi-specific
checks then skip; the Nix check supplies that variable and must not skip them.

`real-provider-probe.mjs` is opt-in, outside the test glob. It uses three bare
sessions with separate runtimes, no tools/project resources, synthetic prompts,
a deadline and a caller-selected trusted provider adapter. It never copies or
prints a token, request headers, provider error bodies, or user transcript. The
probe in this run failed: the authorized route returned HTTP 200 streams with
unsupported-model errors. Real foreground inference is therefore **not proven**.

## Remaining integration work — release withheld

1. Implement and adversarially validate the canonical owner's durable no-run
   admission and compare-parent merge API. The prototype's two appended JSONL
   lines can tear; its idle check bypasses command/event/settled/replacement
   fences. This kernel does not fix Pi JSONL by opening a second writer. It also
   does not turn a DB transaction into a cross-JSONL transaction.
2. Compose the actual resident host: exclusive host/writer leases, non-mutating
   bounded snapshot, registration-before-start, fresh resource/model services,
   session-switch/reload/private-mode admission policy, sealed archive checks,
   rejoin delivery and canonical recovery. The tested SDK setup is not that host.
3. Bind Golem tools and one service-owned subscription to `OwnedChildren`, with
   branch-local event consumption, reconciliation of in-flight creates and child
   cancellation through settlement. Do not ambient-load the existing foreground
   agents extension: it owns a shared settlement directory and worklist fallback.
4. Add total disk/archive/worktree quotas, retention policy and orphan review.
   SQLite page count plus record/admission/report/command limits are NOT total
   disk/archive quotas. No live writer can be evicted on a mere timeout.
5. Add exact admitted-turn browser/hands-free routing and current Projects
   hierarchy/child controls through the existing durable attachment/handoff
   admission path. The companion UI only supports typed runtime receipt
   projection; it intentionally advertises no Background capability/button.
6. Prove real-provider foreground inference alongside background model/tool
   activity and the complete end-to-end acceptance matrix before deployment.

Do not interpret passing component or baseline tests as completion of those
release gates. No resident Presence/Pi restart is needed or authorized for these
commits. A later complete implementation needs a **new host birth** after both
repositories are reconciled and all release checks pass; `/reload` of the
rejected prototype is not a deployment path.
