# Familiar Agents focused recovery — review handoff

## Scope and bases

Fresh isolated worktrees under
`/var/lib/golem/projects/scratch/.golem/worktrees/familiar-agents-focused-recovery/`:

- `familiar/`: fetched `origin/main` at `47a5512748fe41f5d11406a4a51aba383c978b66`.
- `drover/`: fetched `origin/main` at `1c9b5b2`.
- `familiar-ui/`: optional projection based on cached `origin/main` at `a958104`.
  Authenticated UI fetch was unavailable; its base is **not** claimed freshly fetched.

Recovered candidate commits were inspected as source, not accepted as proof:

| Repository | Recovered commits | Focused follow-up |
| --- | --- | --- |
| Familiar | `e092518` worklist withdrawal; `a67b4fc` Agents substrate | `b67f98c` Exo tools, admission/routing hardening and focused tests |
| Drover | `0efc024` native Herdr method forwards | `9c8b8ec` generic enrollment-generation fence |
| familiar-ui (optional) | `8368cc7` existing bounded/private-aware projection | No new UI implementation |

No Background Exo candidate or Pi rebase was merged. No viewer changes, viewer
repair/tests, Presence fixture changes, or vendor secret-scan suppressions were
recovered. No push, deploy, reload, or resident process restart occurred.

## Delivered surface

Foreground Familiar's CLI-only owner flag and explicit enrollment configuration
activate one process owner with an XDG SQLite ledger, durable admission/intent
records, generation/lease fencing, startup reconciliation and non-overlapping
self-scheduled passes. Worklist notifications use a durable deduplicated outbox
and withdrawal tombstones. Polling does not take a foreground dispatch gate.

Exo can call eleven `familiar_agents_*` tools:

- `capabilities`, `dispatch`, `status` (list or inspect with native attach hint);
- `steer`, `answer`, `cancel`, `reconcile`;
- `abandon`, `settle`, `resolve_operation`, `resolve_intent`.

Command equivalents remain available for explicitly attributed operator actions
and retained-work cleanup. Exo decisions are labeled `exo:<session>`, never
impersonated as human commands or agent self-reports. Identical terminal-decision
retries are safe; the first accepted settlement cannot be replaced.

Dispatch supports exact enrolled Pi provider/model and optional bounded thinking
level, a remote repository/ref, and a managed detached remote worktree. Arbitrary
CLI options and ambient controller profiles are not copied. v1 deliberately does
not pretend to support unproved non-Pi harness launch semantics or arbitrary
human worktree reuse. Missing remote preflight requirements fail admission
explicitly; unavailable routes remain unknown rather than terminal.

Every RPC is fenced to Drover's never-reused enrollment port with HTTP
`If-Match`/`ETag`. This closes name-revocation/re-enrollment races without adding
job semantics to Drover or changing Herdr. A matching updated Drover coordinator
is required; the initial read-only ping fails closed without acknowledgment.

The actual Pi process is launched through supported Herdr workspace/agent APIs,
not a wrapper or local tmux fallback. Settlement reads are bounded and limited to
the exact final atomic-file path. Valid version/job/nonce and a rechecked idle or
confirmed-gone observation are required. Idle without settlement stays unresolved;
manual interruption, resumed activity and disconnected machines remain recoverable.
Enrollment grants effective account-level arbitrary shell authority, not a sandbox.

## Provisioning interface

`FAMILIAR_AGENTS_CONFIG` names a private, bounded JSON configuration. It pins the
Drover catalog identity, coordinator/native SSH route, exact worker binaries,
model choices and one of two explicit worker profile mechanisms:

1. An already enrolled remote profile; or
2. `familiar-tiamat-v1`: copy only the four allowlisted Tiamat/debug **source
   files** and a per-job exact-model guard, with credentials referenced by an
   operator-provisioned **remote** `FAMILIAR_TIAMAT_TOKEN_FILE`.

The generated profile now uses Pi's actual `defaultProjectTrust: "never"` value.
There is no tar/import of ambient controller auth, profile, sessions or identity.
Production enrollment was neither inferred nor changed. The operator must provide
verified route/model configuration and an existing authorized remote token-file
reference before a production dispatch. Do not paste credential values into a
review or task. See `familiar-agents-v1.md` for exact configuration and usage.

## Fresh focused checks performed in this recovery

These are new runs, not inherited dead-job logs:

- Pinned Herdr **0.9.0 / protocol 22** binary schema inspected for all used
  workspace, agent and pane operations, including their exact request fields.
- Nix `agents-ledger`: **48 Node tests**, **8 Python tests**, and the real pinned
  Pi-loader tool test covering all **11 tools**.
- Additional tests cover SIGKILL at six ledger boundaries; stale generation
  takeover; no overlapping passes; shutdown of an abort-resistant transport
  child; wrong nonce/malformed/partial/oversized reports; interrupted idle then
  resumed settlement; unreachable then reconnect; ordered uncertain input;
  notification dedup; no local fallback; route-generation mismatch; typed failed
  admission; controller-profile non-copying; private rejection and provenance.
- `bun test integrations/pi/extensions contrib/familiar`: **235 passed**.
- Real extension-loader smoke: **13 entrypoints**, no Bun globals.
- `test/pi-extra-extensions.test.sh`: passed, including the Agents entrypoint and
  CLI-only foreground owner flag.
- Familiar `checks.x86_64-linux.pi-invoke-command`: passed (cached package check).
- Drover: **13 tests passed**, Nix test derivation and default package build passed.
- Optional UI: dependency install without lifecycle scripts, Node build,
  Agents/extension tests and **26 workbench tests** passed.
- Gitleaks on every repository's scoped commit range: **zero findings**.
  Full-tree Drover/UI scans: zero findings. Full-tree Familiar scan reports five
  findings in **unchanged viewer vendor files**; these were not investigated or
  suppressed as part of this scope. No changed Agents code was flagged.
- Scoped `git diff --check` and commit `git show --check`: passed.

Reproducible commands are in `test/agents/README.md`. Private-free execution logs
are outside the nested repositories in the worktree parent (`nix-core-proof.log`,
`nix-check.log`, `final-extension-check.log`, `shell-check.log`, `drover-check.log`,
`ui-check.log`, and the redacted `*-secrets-commits.json` reports).

## Release limits — do not overclaim

This is a reviewable local extension/tool and reconciliation substrate, **not a
production rollout certification**. No provider inference, O'Brien dispatch, or
new live remote foreground/attach proof was run in this recovery. The retained
opt-in live fixture is candidate test code; its old logs are not new evidence.
The focused tool tests use the real Pi loader and ledger with mocked transport;
the Drover tests use isolated loopback HTTP/WebSockets. They do not certify the
production reverse tunnel, worker environment or credentials.

An independent integration/security reviewer should verify the matching Familiar
and Drover revisions, then authorize any bounded cross-host proof and production
enrollment/deployment separately. The optional UI remains a separate commit and
requires authenticated base reconciliation before integration. The Rust viewer
is explicitly out of scope and was neither preserved by repair nor tested.
