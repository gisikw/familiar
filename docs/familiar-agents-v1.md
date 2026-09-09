# Familiar Agents v1

Familiar-owned durable agent dispatch onto explicitly enrolled Drover machines.
This is **not Golem-over-Drover**. The controller is one foreground Pi extension,
not a service. Remote residents are existing Drover + pinned Herdr, plus the real
agent while it runs. No callback, sidecar, MCP server, remote coordinator, or
Herdr fork is installed.

## Authority and trust

**Enrollment grants arbitrary shell authority at the effective authority of the
remote Unix account**, including its existing sudo, containers, network and
filesystem access. Neither the RPC allowlist nor job paths are a sandbox. Paths,
markers, profile manifests and locks are correctness/cleanup measures only.

Settlement is a **trusted agent self-report**, not independent proof of work.
Inspect Git/worktree facts before integration. Herdr `done` means idle/unseen;
it is never a task verdict. The investigation at Herdr stop-reason commit
`049c58f` remains applicable.

v1 admits **Pi only**, with an explicitly enrolled provider/model string. Other
harnesses fail admission rather than receiving guessed CLI arguments. Herdr
still owns all harness detection, observation, keys and attach behavior.

## Configuration and enrollment

Export an absolute `FAMILIAR_AGENTS_CONFIG` path in the foreground Familiar
instance's launch environment. Configuration is private, at most 128 KiB, and
rejects unknown fields. Do not put credentials in Nix or in this repository.

Example (public-key placeholders must be replaced with verified public keys;
**do not paste private keys or bearer values**):

```json
{
  "url": "https://drover.example:9840",
  "token_file": "/run/secrets/drover-client",
  "ssh_config": "/home/operator/.ssh/drover-auth.conf",
  "jump": {
    "alias": "drover-jump",
    "hostname": "drover.example",
    "port": 9841,
    "user": "drover-jump",
    "host_key": "ssh-ed25519 VERIFIED_COORDINATOR_PUBLIC_KEY"
  },
  "idle_grace_ms": 300000,
  "remote_retention_days": 7,
  "machines": [{
    "name": "worker-a",
    "session": "drover",
    "port": 24017,
    "ssh_user": "drover",
    "host_key": "ssh-ed25519 VERIFIED_NODE_PUBLIC_KEY",
    "ssh_alias": "drover-worker-a",
    "herdr_binary": "/absolute/pinned/herdr-0.9.0/bin/herdr",
    "python_binary": "/absolute/python3",
    "profile_mode": "familiar-tiamat-v1",
    "models": ["tiamat-responses-account/model-id"],
    "capture_terminal_context": false,
    "worker_env": {
      "PATH": "/explicit/worker/toolchain/bin:/usr/bin:/bin",
      "FAMILIAR_TIAMAT_URL": "https://tiamat.example",
      "FAMILIAR_TIAMAT_TOKEN_FILE": "/remote/operator-provisioned/tiamat-token"
    }
  }]
}
```

The machine tuple is copied from the authenticated Drover catalog and verified
on each observation: name, session, never-reused route port, SSH user and host
key must agree. Herdr must report **0.9.0 / protocol 22**. The configured jump
identity is explicit because Drover's SSH listener may differ from its HTTP URL.
The inner native SSH endpoint remains the account-level route from Drover's
operations guide, not a forced-command pane attach endpoint.

The original SSH config supplies authentication (IdentityFile/certificate/agent
configuration). Familiar generates a private overlay that pins **both** endpoint
keys, exact host/user/port/jump coordinates, and a dedicated known-hosts file.
It disables ambient host-key commands/DNS trust, multiplexed connection reuse,
agent forwarding and local/remote command hooks. SSH children receive only
PATH, HOME, LANG and the existing local SSH_AUTH_SOCK reference—not the
controller's provider environment. These measures bind routing identity; they
do not limit the enrolled account's shell authority.

The Drover token is read from the explicit regular-file reference, bounded to
8 KiB, never copied into the ledger, profile or logs. It is reread for rotation.
The token itself must be printable, whitespace-free, 32–4096 characters.
Controller and remote token-file references are distinct. URLs cannot contain
userinfo, credential queries or fragments. Controller HTTP is allowed only on
loopback; other Drover URLs require HTTPS (normal Node TLS trust applies).

### Worker profiles

Two explicit mechanisms are supported:

* `profile_mode: "familiar-tiamat-v1"` creates a **per-job** Pi profile. It copies
  only four source files from Familiar: Tiamat `index.ts`, `catalog.ts`,
  `usage.ts`, and `lib/debug.ts`. The code bundle is captured in the admission
  record, digest-pinned, and retained across controller code changes. It never
  reads/tars a controller Pi profile, auth store, identity, skills or sessions.
  Credentials stay in the operator-provisioned **remote** token file referenced
  by `worker_env`. The profile disables project-resource trust by default;
  this is resource-loading policy, **not** a filesystem sandbox.
* `profile_mode: "enrolled"` (the compatibility default) requires an absolute
  `profile` path to an already configured remote Pi profile with settings.json.
  This supports explicitly installed worker tools/providers. No content from a
  controller profile is copied. Credentials in that remote profile are an
  explicit operator enrollment decision. A generated profile does not require
  the `profile` field.

Both install the existing pinned `herdr integration install pi` asset into the
selected profile. Familiar does not implement its own harness activity/settlement
hook. A separate tiny per-job **model-selection guard** is passed with Pi's
`--extension`: Pi intentionally supports fuzzy CLI model matching, whereas this
admission contract requires the exact enrolled provider/model. The guard refuses
a mismatched startup/first provider request before inference; it never reports
activity or completion. After the initial exact request, manual model steering
and reload remain possible. The guard's source is also captured at admission;
no controller profile or credential file is used to build it.
The current Tiamat extension uses `FAMILIAR_TIAMAT_URL` and the absolute
`FAMILIAR_TIAMAT_TOKEN_FILE` reference; inference resolves the token per request.
See `integrations/pi/extensions/tiamat/README.md`.

Preinstall Pi, Git, Python and Pi's normal runtime utilities (including fd/rg)
in the enrolled account's **interactive** shell environment. A shell rc may
reset PATH or cwd; v1 verifies the actual agent's initial cwd before prompting
and does not silently choose another executable/harness. `python_binary` may
select an absolute Python interpreter when the account's noninteractive PATH
does not contain python3. Provisioning is a short-lived SSH/Python/Git operation,
**not a Herdr space**. Only the subsequently launched real Pi is foreground in
the dedicated named Herdr space.

## Ownership, ledger and reconciliation

Default ledger: `${XDG_STATE_HOME:-~/.local/state}/familiar/agents/agents.sqlite3`.
`FAMILIAR_AGENTS_STATE_DIR` selects a different private root; use it for isolated
instances. Keep the WAL database on a local filesystem, not shared across hosts.
Schema v1 initializes transactionally and refuses unsupported versions/shapes;
there is no import of rejected Golem ledgers or pre-release fixture databases.

Indexed SQLite columns enforce job/admission uniqueness and semantic state;
bounded job/provenance/intent records live in the same transactional ledger as
JSON. There is a separate durable notification outbox. WAL + synchronous FULL,
short synchronous transactions, revision CAS and lease-generation checks fence
all writes. There is no transaction across a network await.

`familiar.sh pi` passes the **CLI-only** `--familiar-agents-owner` flag. Only a TUI
session with that flag starts an owner. A process-wide Symbol on `process`
prevents loader/session duplicates, and the DB lease fences other processes.
The lease records PID/host/boot identity: a provably dead local owner can be
taken over immediately; uncertain/alive owners retain their lease until expiry.
A stale generation cannot renew, mutate jobs or acknowledge notifications.
Startup schedules full reconciliation immediately; shutdown aborts and is
idempotent. Polling uses a self-scheduling setTimeout after the previous pass,
never overlapping setInterval work.

Background Exo/other SDK sessions must not inherit the foreground CLI flag.
They do not start a poller. Future background dispatch integration should use a
fenced foreground capability, not construct another Owner. This work does not
merge or alter the unpushed Background Exo branches. Its only shared worklist
addition is a neutral durable withdrawal primitive for expired notifications.

No Familiar/UI foreground dispatch gate is acquired for network work. Tools
persist/admit intent and return; the owner performs network reconciliation
separately. Browser projection is a bounded, synchronous read through the
existing familiar-ui snapshot bridge—no additional listener or bearer token.

### Durable phases and uncertain operations

1. A **read-only plan** resolves the remote XDG paths, source commit and profile.
   The controller persists this plan before any provisioning mutation. Changing
   a ref/XDG environment after a crash cannot move the job or its cleanup path.
2. Native provisioning is idempotent under a per-job lock; a remote marker pins
   the initial commit. It preserves later human work rather than resetting it.
3. Create/recover the uniquely named workspace, then start/recover the named Pi.
   Names encode the full UUID (base36) rather than a collision-prone short prefix.
4. Send the task and atomic settlement contract with `agent.prompt`.

Herdr 0.9 has no durable mutation receipt/idempotency token. Before workspace,
launch, prompt and input delivery, Familiar records the attempted/unknown state.
It does **not** blindly resend after a lost reply. Stable workspace/agent names
allow discovery; remaining uncertainty is explicit in status and has an
operator-resolution command. Confirm absence/delivery through native inspection
and allow in-flight Drover requests to quiesce before authorizing a retry.

Herdr agent targets are **pane IDs or names, not terminal IDs**. The ledger also
retains terminal ID and agent-session reference for correlation. agent.get
reconciles pending managed startup; agent.list alone does not. agent.start args
reject control characters, so multiline task text goes through agent.prompt,
not argv. Pi receives explicit `--provider`, `--model` and the per-job guard
extension; no wrapper hides its foreground process. Its 300-second startup TTL
is distinct from the 20-second controller
network deadline; an expired RPC is an uncertain operation, not a task verdict.

Exact pinned source: `b99002ac99b09e00b4ca692436cb15a6b0d676f1`,
`src/api/schema/{agents,panes,workspaces}.rs`, `src/app/agents.rs`,
`src/app/api/agents.rs`, and `src/terminal/state.rs`. Drover only adds forwarding
for workspace.create/close, agent.send_keys, pane.send_input and pane.process_info.

## Completion and manual intervention

* working → running; blocked → blocked when Herdr reports it.
* idle/done **without** settlement → idle_unsettled, never success/failure.
* valid atomic settlement + rechecked idle/no active agent → settled, once.
* gone without a valid report → unresolved/gone with attention, not failure.
* route loss → unknown/degraded reachability, not a terminal semantic state.
* resume → running, clear the idle timer; later self-settlement remains valid.

Settlement schema v1 validates job ID, unpredictable nonce, verdict
(done/failed/cancelled), RFC3339 timestamp, bounded summary and optional usage,
artifacts and worktree report. Only the exact final path is read, as a regular
non-symlink file; partial temp files are ignored. Artifact paths are report data,
not fetch/delete commands. First accepted report wins. An operator settlement
is separately attributed and is not represented as agent proof.

A human can attach, interrupt, edit or steer directly through native Herdr.
Familiar's cancellation is durable intent, **not** a cancelled verdict. A
pre-launch cancellation withholds new launch/task submission and awaits explicit
abandon/operator settlement. In-flight operations remain uncertain. Cancellation
can be delivered even when the settlement-file route fails.

Answers are raw text + Enter through the supported pane input API, not an
invented typed question method. They require a fresh blocked observation and
are fenced to its sequence/episode/observation continuity. A native human answer,
new blocker or lost continuity prevents stale delivery and requires resolution.
No unavailable question details are invented. `capture_terminal_context: true`
is an explicit opt-in to copy a bounded **raw terminal excerpt** into the ledger,
worklist and browser. It may contain echoed prompts or sensitive output; off is
the default. Native attach remains available.

Blocked and idle attention items deduplicate by durable episode; obsolete items
are withdrawn using archive tombstones, including a late producer after process
death. Accepted settlement notification uses one permanent job-scoped ID.
`/private` cannot dispatch/steer Agents work: declassify it first. Private mode's
own model has no tools, and the foreground commands/tools additionally check its
public/private span marker. The browser omits the Agents projection while private.

## Surface

Tools: `familiar_agents_capabilities`, `familiar_agents_dispatch`,
`familiar_agents_status`, `familiar_agents_steer`, `familiar_agents_answer`,
`familiar_agents_cancel`, `familiar_agents_reconcile`.

Dispatch requires a caller key, machine, Pi harness, exact enrolled model,
absolute **remote** repository path, requested_ref, task and label. No local
repository, tmux job or model is substituted. Status pages five jobs; full
inspection is by id. Model-facing output is capped at 48 KiB with an explicit
truncation marker; the full bounded record remains available in the ledger.

Operator commands (record the command-channel session attribution):

```text
/familiar-agents
/familiar-agent-abandon <id> <reason>
/familiar-agent-settle <id> <done|failed|cancelled> <summary>
/familiar-agent-resolve-intent <id> <intent-key> <reason>
/familiar-agent-resolve-operation <id> <workspace|launch|prompt> <retry-confirmed-absent|prompt-confirmed-delivered> <reason>
/familiar-agent-cleanup <id>
```

Abandon does not kill/delete the remote agent. Resolving an uncertain intent
retires it; a new delivery needs a new key. Operator attribution identifies the
explicit command channel, not cryptographic proof of a particular human.
Legacy contrib `agents_*`/Golem tools are separate and are not used as fallback.

## Bounds and retention

* 32 semantically active jobs, 8 per machine; at most 4 jobs reconciled concurrently.
* Task ≤24 KiB (reserving room for the contract and long remote paths); total
  injected prompt ≤32 KiB; settlement ≤32 KiB; summary ≤8 KiB;
  artifacts ≤32; usage nonnegative safe integers; path report strings bounded.
* Network/SSH output ≤1 MiB; each owner call ≤20 seconds, abortable; lease 120 s,
  renewed transactionally between calls. Base cadence 1–30 s (idle 15 s),
  with ±20% jitter.
* Idle grace defaults to 5 minutes; configurable 1 s–24 h.
* Cleanup is explicit after `remote_retention_days` (default 7, range 0–3650).
  Retained idle harnesses/workspaces are not counted as semantically active jobs;
  they consume machine resources until manual close or explicit cleanup.
* Cleanup refuses active/replaced agents, changed topology, unknown foreground
  processes, dirty/untracked worktrees and unidentified files. It is retryable,
  including partial provisioning and death during deletion. It never uses force.
* Generated per-job profiles/session history are cleaned with that job. Shared
  enrolled profiles and credential files are never removed.
* Per-job lock inodes and tiny nonce-correlated retirement markers remain outside
  the removed job directory. They prevent a delayed old provisioning call from
  resurrecting cleaned work. They are not a remote semantic ledger/service.
* After completed cleanup and 90 days, ledger GC removes report/code-bundle/intent
  details in bounded batches. Admission IDs/hashes, source/report digests, verdict,
  core metadata and operator attribution remain as idempotency/audit tombstones.
  Worklist archive retention is independently owned by the existing worklist.

See `test/agents/README.md` for isolated proofs. O'Brien and reconciliation with
later main/Background Exo movement remain required external release validation;
local proof must never be relabeled as cross-host evidence.
