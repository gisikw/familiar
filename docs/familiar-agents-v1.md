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
instance's launch environment, or set `[familiar] agents_config` in
`familiar.toml` (see `docs/CONFIG.md`); an ambient explicit variable still wins.
Configuration is private, at most 128 KiB, and rejects unknown fields. Do not
put credentials in Nix or in this repository.

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
key must agree. Every Herdr RPC additionally sends `If-Match: "<enrollment-port>"`;
Drover checks the never-reused port against the authenticated live connection
before forwarding and acknowledges it with `ETag`. Familiar requires the
acknowledgment even on the initial read-only ping, failing closed against an old
coordinator. Revoking and re-enrolling a name cannot redirect an in-flight job to
its replacement. This is a generic route-generation fence, not Familiar job
semantics. Herdr must report **0.9.0 / protocol 22**. The configured jump
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

### The node execution runtime (where `pi` comes from)

Herdr 0.9 `agent.start --kind pi` **types the canonical executable name into the
dedicated pane's interactive shell**; `AgentStartParams` (protocol 22) carries
`name`, `kind`, `pane_id`, `args` and `timeout_ms` only — no environment. By the
time that line runs, the pane shell's own startup files own PATH. On NixOS this
is unconditional: `/etc/bashrc` sources `/etc/profile`, which sources
`set-environment`, which re-exports `PATH`. An environment handed to
`workspace.create` therefore reaches the pane *process* (variables such as
`PI_CODING_AGENT_DIR` and `FAMILIAR_AGENT_EXPECTED_MODEL` do survive) while
`PATH` does not, and the launch fails with `bash: pi: command not found`.

The fix belongs entirely to the **Drover/driver node**: its Herdr terminal spawn
must source the node's own trusted Drover environment, so the intended canonical
runtime (Pi plus the runtime bits its agents need) is established for every agent
pane. That is one consistent node-owned runtime across jobs, provisioned however
the node is managed (Nix on our fleet). It is **not** part of the per-job
protocol, and it is configured on the node, not in this repository.
Project-specific `nix develop` remains separate and optional — the agent's own
choice inside its worktree.

Familiar sends semantic inputs only — agent kind, exact provider/model, model
guard, task. It does **not** probe, inject, select or attest the pane PATH: a
`command -v` style preflight would only show that *some* `pi` is resolvable,
which is no provenance guarantee, so there is deliberately no such machinery.
The enrolled `worker_env` is still passed to `workspace.create`, but nothing in
v1 treats it as proof that the launch will succeed. What Familiar does instead is
observe the outcome truthfully; see the launch-pending reconciliation below.
`test/agents/launch-proof.mjs` records the Herdr semantics and the node-side
fix against a real pinned Herdr 0.9 server.

## Ownership, ledger and reconciliation

Default ledger: `${XDG_STATE_HOME:-~/.local/state}/familiar/agents/agents.sqlite3`.
`FAMILIAR_AGENTS_STATE_DIR` (or `[familiar] agents_state_dir`) selects a
different private root; use it for isolated instances. Keep the WAL database on
a local filesystem, not shared across hosts.
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
   A completed failed plan returns a fixed credential-free admission error and
   marks `failed_admission`, with one worklist notice. A lost route remains
   unknown and retryable, never terminal.
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

### Launch-pending placeholders and startup failure

`agent.start` returns immediately with a **placeholder**: the requested `name`,
`launch_pending: true`, `agent_status: "unknown"`, `state_change_seq: 0` and **no
`agent` kind**. It appears in `agent.list` and `agent.get` alike. Familiar treats
that exact shape as a truthful *pending startup* (`observation:
"launch_pending"`, the pending terminal id retained separately as
`herdr_pending_terminal_id`), never as an interactive agent: it is not an
identity mismatch, it is not prompted, and it is never relaunched.

Herdr does not reap a placeholder whose startup failed, and the name stays taken
for that session: a second `agent.start` returns `agent_name_taken`, `agent
rename` returns `agent_launch_pending`, and `pane.release_agent` /
`pane.clear_agent_authority` do not remove it. Only closing the workspace
releases the name. So after the launch grace (60 s), if the pane proves there is
no harness process (the shell is its own foreground process group), the job moves
to phase `launch_failed` with one notification and an explicit error. There is no
automatic relaunch and `resolve-operation launch` does not apply: recovery is
operator-driven — inspect natively, `abandon`, let cleanup close that workspace
(cleanup accepts exactly this proven-failed placeholder shape and nothing else),
and dispatch a fresh job once the node's agent runtime is correct.

Exact pinned source: `b99002ac99b09e00b4ca692436cb15a6b0d676f1`,
`src/api/schema/{agents,panes,workspaces}.rs`, `src/app/agents.rs`,
`src/app/api/agents.rs`, and `src/terminal/state.rs`. Drover only adds forwarding
for workspace.create/close, agent.send_keys, pane.send_input and pane.process_info.

## Agent availability policy (per route, per node)

Enrollment is the hard outer bound; availability policy is a further
restriction inside it. Provider/model access for delegated Agents is **not**
carte blanche: each exact route may be enabled on each exact enrolled machine.

* **Route identity** is the complete existing `provider/model` string — the
  registered Pi/Tiamat provider id and the exact model id, as already enrolled.
  Vendors are never inferred from model names.
* **Node identity** is the enrolled machine id (`machines[].name`).
* **Semantics** (the approved picker wireframe, unchanged):

  ```ts
  routePolicy = { on: boolean, fallback: "allow" | "deny",
                  overrides: Record<nodeId, "allow" | "deny"> }
  effective(node) = !on ? "deny" : (overrides[node] ?? fallback)
  ```

  Explicit beats fallback; absence is deny; a newly enrolled node inherits the
  fallback with no state rewrite; turning a route off is non-destructive;
  offline nodes and routes keep their settings; foreground model selection never
  mutates policy. Policy can never authorize an unenrolled model, node, harness,
  provider or credential — a mutation naming an unenrolled route or machine is
  refused as `invalid_request`.

### Persistence

One private JSON file in the existing Agents state root:
`${FAMILIAR_AGENTS_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/familiar/agents}/agent-policy.json`,
mode 0600 inside the 0700 state root, written to a unique temporary file, fsynced,
renamed, and the directory fsynced. The foreground Agents owner is the single
in-process writer (a process Symbol refuses a second one).

```json
{"version":1,"seq":3,"routes":[{"route":"provider/model","on":true,"fallback":"deny","overrides":{"worker-a":"allow"}}]}
```

Serialization is deterministic: routes sorted by exact route string, override
keys sorted, fixed key order, one trailing newline. The **revision** is the
first 32 hex characters of the SHA-256 of those canonical bytes, and every
accepted mutation bumps `seq`, so each accepted write yields a new revision.
Mutation is compare-and-set against it.

Bounds: 256 routes, 128 overrides per route, 256-byte routes, 128-byte node ids,
64 KiB file. Known absence is an empty **fail-closed** policy with a real
revision, so the first mutation needs no hand-edited file. A malformed file, an
unknown version, an unknown field, a duplicate exact route, a bound violation or
an unreadable file refuses **both** enforcement and mutation: dispatch denies and
the operator's file is neither rewritten nor erased. There is no browser
`localStorage` authority and no generic policy engine.

### Enforcement at dispatch

`imp agent dispatch` validates the basic request and exact enrollment
(machine, `pi` harness, exact enrolled model) first, then reads the policy file
and checks the effective decision — **before** any ledger admission, worklist
notice or Drover/Herdr contact. A denial throws a typed `policy_denied` error
naming the exact route and machine and leaves no job: nothing was admitted, so a
rejected admission record would misrepresent work that never entered the ledger.
The CLI cannot claim approval: no dispatch argument participates in the decision.
Policy is re-read from the file on each check inside the single resident process,
so a dispatch already admitted before a later toggle continues to completion
(expected — the toggle is an admission gate, not a kill switch), while every
later dispatch sees the newer effective policy.

### Same-process familiar-ui seam

While the foreground Agents owner exists, it publishes a fixed service at
`Symbol.for("familiar.agent-policy.v1")` and removes it identity-safely on
shutdown (a later owner's service is never deleted):

```ts
{ read(): AgentPolicySnapshot;
  mutate(expectedRevision: string, mutation: AgentPolicyMutation): AgentPolicySnapshot }

AgentPolicySnapshot = {
  version: 1, revision: string,
  nodes: { id: string, routes: string[], reachability?: "online" | "offline" }[],
  routes: { route: string, on: boolean, fallback: "allow" | "deny",
            overrides: Record<string, "allow" | "deny"> }[] }

AgentPolicyMutation =
  | { action: "set-on", route: string, on: boolean }
  | { action: "set-fallback", route: string, fallback: "allow" | "deny" }
  | { action: "set-override", route: string, node: string, decision: "allow" | "deny" }
  | { action: "clear-override", route: string, node: string }
```

Nodes and routes are sorted; `reachability` appears only when truthfully known.
Familiar currently tracks liveness per job, not per machine, so v1 publishes no
`reachability` field rather than guessing one; the field exists for a later
truthful source.
No credential, remote path, SSH configuration, token, raw Owner or generic
invocation crosses this seam. Errors are thrown with typed `code`:
`stale` (revision conflict), `invalid_request` (shape, bound, or unenrolled
route/machine), `unavailable` (no owner, private span, or refused policy state),
`policy_denied` (dispatch decision). After an accepted mutation the extension
emits the narrow `familiar:agent-policy-changed` event so familiar-ui re-reads
the snapshot. Usage telemetry stays Tiamat-owned, read-only, and is not policy
state; the UI joins these exact provider/model strings against familiar-ui's own
truthful Tiamat provider projection.

### Bootstrap and debug from the shell

The same handler, socket and resident CAS back `imp agent policy`:

```sh
imp agent policy show --json
imp agent policy on   tiamat-responses-account/model-id on
imp agent policy fallback tiamat-responses-account/model-id deny
imp agent policy override  tiamat-responses-account/model-id worker-a allow
imp agent policy clear-override tiamat-responses-account/model-id worker-a
```

Enabling one exact route on one exact node for first deployment is therefore two
commands (`on` then `override … allow`) with no hand-edited file and no race:
when `--revision` is omitted the resident reads the current revision and applies
the mutation without an intervening await, and it is the only writer. Supply
`--revision REV` to make the compare-and-set explicit. There is no bypass verb:
`dispatch` always enforces the current effective policy server-side.

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

The model surface is the singular shell-native `imp agent ...` area inherited
through resident Pi's Bash tool. No `familiar_agents_*` tools are registered in
Pi's model schema. Run `imp agent --help` and command-specific help for the full
catalogue. The fixed operations are `capabilities`, `dispatch`, `status`,
`steer`, `answer`, `cancel`, `reconcile`, `abandon`, `settle`,
`resolve-operation`, `resolve-intent`, and `policy` (wire operations
`policy-show` and `policy-set`).

The ordinary resident loads a tiny independent Imp ingress and this Agents
owner extension. The ingress owns the one private `FAMILIAR_IMP_SOCKET` and
routes only the fixed `plate` and `agent` areas through same-process Symbols.
Agents publishes its handler only while the explicit foreground
`--familiar-agents-owner` authority has a live Owner; missing config/ownership
returns unavailable without affecting Plate. The CLI cannot provide attribution,
access SQLite, invoke SSH, or select another session.

All recovery actions are callable by foreground Exo without impersonating a
human command. Tool decisions are attributed as `exo:<session-id>`; commands
retain `operator-command:<session-id>`. Explicit settlement is controller
judgment, never agent proof. Identical abandon/settle retries are idempotent;
conflicting terminal decisions cannot replace the first one. Operation/intent
resolution requires native inspection and a reason recording that evidence,
not just an automatic retry after a timeout.

Dispatch requires a caller key, machine, Pi harness, exact enrolled model,
absolute **remote** repository path, requested_ref, task and label. Worktrees
are always freshly managed detached worktrees under the remote job state path;
v1 does not reuse arbitrary human worktrees or fetch controller repositories.
Optional `options.thinking` accepts Pi's documented off/minimal/low/medium/high/
xhigh/max levels (Pi may clamp to model capability). No arbitrary CLI argv,
environment, extensions or credentials can be supplied through tools. Options
are persisted and included in admission idempotency. No local repository, tmux
job or model is substituted. Status pages five jobs; full inspection is by id,
including typed native attach coordinates and a Drover client invocation hint.
Both model text and tool details are capped at 48 KB. Oversized results return a
valid JSON truncation envelope with an explicitly incomplete text preview; the
full bounded record remains available in the private ledger.

Example Exo workflow (shell commands through Bash):

```sh
imp agent capabilities --machine worker-a --json
imp agent policy show --json
imp agent dispatch --key review-123 --machine worker-a --harness pi \
  --model tiamat-responses-account/model-id --thinking high \
  --repo /remote/repo --requested-ref main --label 'review change' \
  --task 'Implement, test and review the requested change; do not push.' --json
imp agent status '<returned-job-id>' --json
imp agent steer '<returned-job-id>' --key review-123-steer-1 \
  --text 'Also check the regression test.' --json
```

Retain the caller key after a lost dispatch reply; do not mint a new one simply
because the foreground restarted. `imp agent reconcile` forces observation,
not replay of uncertain mutations. A cancel request waits for settlement or
explicit abandon; it is never represented as a cancelled verdict by itself.

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
  processes, dirty/untracked worktrees and unidentified files. For a retained
  managed process it requires one process that owns the observed foreground
  group and has the exact worktree cwd. Herdr 0.9 reports ordinary Linux Pi as
  `name: "pi"`; on Darwin its native `comm` can remain `name: "node"` while its
  independently collected KERN_PROCARGS2 `argv0` is `"pi"`. The latter is
  accepted only with the complete matching machine/workspace/pane/terminal/
  harness/session/cwd chain. Arbitrary Node, argv0-only, shell, human and
  multi-process observations fail closed. Cleanup is retryable, including
  partial provisioning and death during deletion. It never uses force.
* Generated per-job profiles/session history are cleaned with that job. Shared
  enrolled profiles and credential files are never removed.
* Per-job lock inodes and tiny nonce-correlated retirement markers remain outside
  the removed job directory. They prevent a delayed old provisioning call from
  resurrecting cleaned work. They are not a remote semantic ledger/service.
* After completed cleanup and 90 days, ledger GC removes report/code-bundle/intent
  details in bounded batches. Admission IDs/hashes, source/report digests, verdict,
  core metadata and operator attribution remain as idempotency/audit tombstones.
  Worklist archive retention is independently owned by the existing worklist.

See `test/agents/README.md` for isolated proofs. Local Darwin-remediation tests
are not a release pass: blocked/answer, interrupt/resume, reconnect and
owner-crash rows still require a resumed isolated O'Brien matrix after review.
Reconciliation with later main/Background Exo movement also remains required;
local proof must never be relabeled as cross-host evidence.
