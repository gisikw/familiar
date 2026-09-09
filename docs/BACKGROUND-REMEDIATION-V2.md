# Background Exo remediation v2 — incomplete; do not deploy the feature

## Bases and authority

Fresh isolated worktrees were created for this job, not modifications to the
resident checkouts:

- Familiar base: `47a5512748fe41f5d11406a4a51aba383c978b66`, fetched main.
- familiar-ui base: `a958104892733d30aa89735fb6dd7f1e5e4fa270`, the operator-authorized
  cached main. Remote authentication failed; freshness and push remain unverified.
- Research: `1cb6dba944e9f752a31e49d44f5001b570debc75`.
- Rejected prototypes: Familiar `67060bb42045151f0f8f2a1a7a00d91b04f61276`, UI
  `fe10594d8482b7184179cbd697e48072a16f8053`.
- Both prior adversarial review documents were read. Neither prototype was
  cherry-picked or enabled.

## Implemented work and iteration

See [the kernel contract](../packages/background/README.md) for implementation,
limits, test commands and remaining host integration obligations.

This run implements a transactional scheduling kernel instead of retaining the
prototype's split JSON indexes, payload-unbound admission keys, generation bug,
metadata-only merges and awaited branch turns. It adds owned-child adapters over
the existing Golem API, run-specific settlement, explicit refusal/narrowing/return,
nonblocking durable command acceptance, timeout quarantine and shutdown handling.

Adversarial iteration found and fixed further issues:

1. Abort completion alone was insufficient to retire a writer. The scheduler now
   waits for both abort and the outstanding run, with a finite deadline; an
   uncertain writer remains quarantined and is not disposed/reused.
2. Shutdown initially attempted ordinary cancellation during rejoin. It now
   preserves rejoin delivery intent for canonical reconciliation.
3. A quarantined run's timer initially survived shutdown. Retirement clears it.
4. Golem SSE events lack complete blocked questions/settlements. The ownership
   adapter fetches authoritative job detail and requires review acknowledgement.
5. Existing Golem HTTP and SSE buffers/deadlines were unbounded. Production
   transport now bounds responses, connects and requests, removes SSE abort
   listeners, and propagates consumer failures rather than silently dropping them.
6. Destruction can synchronously emit HTTP end/aborted events (reproduced under
   Bun). Failure must settle **before** destroying the transport or a timeout can
   masquerade as a successful truncated body. Regression tests cover this order.
7. The existing private-instance path test inherited the enclosing Pi agent
   directory, invalidating its TOML-only assertion. The test now unsets only that
   override; runtime override semantics remain unchanged.
8. A final race test found duplicate concurrent Golem invalidations could both
   return acceptance after one had already committed. Acceptance is now decided
   inside the transaction; duplicate job IDs also reject within one workstream,
   and empty text-array admissions are refused.

The companion UI adds a strict public-identity-only typed dispatch receipt,
message-free browser projection, private-span exclusion, and desktop/mobile live
bridge tests. Arbitrary metadata, archive paths, prototype prose and fabricated
assistant messages are rejected. No Background capability/action/button is
advertised before a real host exists; current Projects/composer behavior is kept.

## Validation performed

| Check | Result |
| --- | --- |
| Background component + installed compiled Pi tests | **80 passed** |
| Actual SIGKILL/reopen tests | **60 boundaries**, included above |
| Compiled SDK concurrency | **100 cycles**, foreground stream completes while two branch streams remain active |
| Pi model conversion of complete merge packet | Passed against compiled pinned Pi 0.84.1 |
| Familiar Pi extensions + contrib tests | **241 passed** |
| Familiar shell regression scripts | **9 scripts passed** |
| Presence isolated lifecycle suite | **12 passed** |
| Native viewer `cargo test --all-targets` | **97 passed** |
| Gateway Bun suite | **18 passed** |
| Subscriber + zip harness | Passed; synthetic attach override prevents resident Presence dependency |
| Familiar host-system flake check | Passed, including new background-core and existing pinned Pi checks |
| familiar-ui npm check | **261 Node + 162 web passed**, types/format passed |
| familiar-ui Nix check/build | Passed |
| Pinned Playwright 1.61.1 | **41 passed, 7 intentional platform skips** |
| Gitleaks redacted diff scans | No findings in either repository |
| Whitespace checks | Clean |

The first test attempts exposed missing test-environment dependencies: the bare
Bun run lacked age/PI_PACKAGE_DIR, node cannot run Bun-only gateway tests, the
stock browser cache cannot execute on NixOS, and the zip harness needed package
resolution. All were rerun in the declared shells with the pinned browser
closure and correct runtime. The private-instance failure was repaired as above.
Generated browser screenshots were restored, not included as changed fixtures.

The real-provider probe used only synthetic prompts, three in-process sessions,
independent model/runtime state and an existing Golem-authorized provider adapter
from Golem `54db8d14de6f14465bb58ef7aaa21a14bff244e6`. It did not copy credentials,
log tokens, serialize request/error bodies, launch Pi workers, or expose user
history. The final probe got HTTP 200 streams but **unsupported-model errors**;
real foreground inference concurrency is **not proven**. No attempt was made to
change the authorized model, provider configuration, account, or credentials.

The synthetic SDK test is not a real-provider proof, and the browser receipt test
is not a Background admission flow. The SIGKILL suite covers this kernel's 20
persistence operations, **not unimplemented Pi JSONL persistence boundaries**.

## Release decision and remaining architectural work

**The full task is not complete. No claim of shippability is made.** The
architectural bridge from transactional intent to the live canonical Pi writer
is still missing: non-mutating bounded snapshot, crash-safe no-run admission,
complete command/event/replacement/settled fencing, and exactly-once brokered
canonical merge. The prototype does not supply a safe substitute. No new Pi
patch was landed, so existing `/private` and direct-command behavior remain intact.

Also incomplete: actual resident host/lease integration, Golem tool/subscription
binding and cancellation through settlement, complete disk/archive/worktree
quotas, current Projects hierarchy and Background composer admission, exact-turn
hands-free routing with inalienable controls, and the complete integrated
acceptance matrix. These are implementation gaps, not waived acceptance gates.

Both repositories are left unpushed. The supervisor must authenticate, fetch and
reconcile current mains, inspect the complete commit ranges, and rerun checks
against the reconciled pair. Fast-forward safety alone is not release approval;
**do not push these as a completed Background feature**.

No resident Presence/Pi was restarted. There are no new-birth steps for this
incomplete feature. Once host integration is complete and all gates pass, deploy
both repositories together and start a new resident host birth; do not attempt to
activate the rejected prototype with `/reload`.
