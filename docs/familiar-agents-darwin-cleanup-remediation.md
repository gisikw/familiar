# Familiar Agents Darwin cleanup remediation

## Scope and outcome

This is the local remediation of the single cleanup compatibility defect found
by the real Azula-to-O'Brien acceptance gate. It is based on clean Familiar
`dc7e84df0251d3038ff89a22e4fdac0107132c2c`. Drover remains unchanged at clean
`9c8b8ecdbd0717c7a9285b046c9d6c3afc6f4246`.

No provider inference, live dispatch, push, deployment, permanent service,
resident-service restart or destructive remote action was performed. The
implementation changes only Familiar cleanup, focused tests and documentation.

## Source-grounded process identity

The inspected pin is Herdr 0.9.0 source
`b99002ac99b09e00b4ca692436cb15a6b0d676f1`:

- `src/api/schema/panes.rs` defines `PaneProcessInfoProcess` with required `pid`
  and `name`, plus optional `argv0`, `argv`, `cmdline` and `cwd`. The enclosing
  process info has shell PID, foreground PGID and a serde-defaulted process Vec.
- `src/app/api/panes.rs` obtains the foreground job from the pane shell PID and
  adds process cwd using the platform collector.
- `src/platform/macos.rs` enumerates the native foreground process group, reads
  `name` from `proc_bsdinfo.pbi_comm`, reads `argv0` independently from
  `sysctl(KERN_PROCARGS2)` and reduces it to a basename, and reads cwd through
  `PROC_PIDVNODEPATHINFO`.
- `src/platform/linux.rs` obtains `name` from the process comm and cwd from
  `/proc/<pid>/cwd`; its foreground-process `argv0` is absent.

Those semantics explain the exact live Darwin tuple `name: "node", argv0:
"pi"`, while preserving Linux `name: "pi"`.

Automatic cleanup now accepts either representation only for one process that
owns the observed non-shell foreground process group and has the exact managed
cwd. The acceptance path additionally requires the existing authenticated
machine-generation check and exact workspace label/id, sole pane and process
pane, agent name/terminal/pane/harness/session, idle/done and non-launch-pending
state, and agent cwd facts. It does not generalize Node acceptance beyond the
specific Pi pair. Missing/wrong argv0, wrong/missing cwd, multiple processes,
shell foreground, process-group mismatch, changed process pane, replaced
session, and active/replaced/moved/human/ambiguous/uncertain observations refuse
before workspace close or native deletion.

The pre-existing Herdr 0.9 empty/omitted `foreground_processes` behavior is
unchanged: only `foreground_process_group_id == shell_pid` can make that case
safe, both with an idle agent record and after agent exit.

## Local regression evidence

Run from the modified Familiar worktree on x86_64 Linux:

- `nix develop .#agents -c node --test integrations/pi/extensions/agents/*.node-test.mjs`
  — 76 tests passed, including focused Linux/Darwin acceptance and refusal rows.
- `nix develop .#agents -c python integrations/pi/extensions/agents/test_remote.py`
  — 8 tests passed.
- `nix develop .#agents -c node test/agents/tools.mjs`
  — the real Familiar-pinned Pi loader registered all 11 Agents tools and passed
  foreground gating, action, provenance, private rejection and restart/
  idempotency checks without inference.
- `PATH=<Nix jq>/bin:$PATH bash test/pi-extra-extensions.test.sh`
  — passed, including the Agents entrypoint and foreground owner flag.
- `nix build --no-link .#checks.x86_64-linux.agents-ledger`
  — built successfully with the modified source and reran Node, Python and real
  pinned-loader checks in the Nix derivation.

- `git diff --check dc7e84d..HEAD` and `git show --check HEAD` — passed.
- Gitleaks 8.30.1 over the single `dc7e84d..HEAD` remediation commit — no
  findings.

The resulting commit remains local and unpushed.

## Remaining release gate

This local result is not a cross-host release pass. The stopped blocked/answer,
interrupt/resume, reconnect and owner-crash rows still require a resumed,
isolated O'Brien matrix against newly reviewed exact revisions after review.
