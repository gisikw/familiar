# `imp`

`imp` is Familiar's private, CLI-shaped model tool. It is not a public Familiar
administration CLI. Familiar adds it to `PATH` only in the process environment
used to launch its resident Pi, so Pi's model-callable Bash children inherit it.
A normal shell and the other Familiar service shells do not.

Run `imp --help`, then `imp agent --help` or `imp attn --help`, for progressive
command discovery. Human-readable output is concise and bounded; every command
accepts `--json`. Commands which take prose accept a lone `-` in place of their
prose option and read stdin. Agent tasks are limited to 24 KiB, Agent text and
summaries to their existing 4–8 KiB bounds, and Attention prose to 64 KiB.

## Examples

```sh
imp agent capabilities --json
imp agent capabilities --machine worker-a
imp agent dispatch \
  --key review-123 --machine worker-a --harness pi \
  --model tiamat-responses-account/model-id --thinking high \
  --repo /absolute/remote/repo --requested-ref main \
  --label 'review change' --task 'Implement, test, and review; do not push.' --json
printf '%s\n' 'Also inspect the recovery test.' |
  imp agent steer JOB_ID --key review-123-steer-1 - --json
imp agent status JOB_ID --json
imp agent status --offset 5 --json
imp agent cancel JOB_ID --key review-123-cancel-1 --json
imp agent reconcile --json
```

Recovery and explicit judgment remain deliberately explicit:

```sh
imp agent abandon JOB_ID --reason 'superseded after native inspection' --json
imp agent settle JOB_ID done --summary 'inspected worktree and tests' --json
imp agent resolve-operation JOB_ID prompt prompt-confirmed-delivered \
  --reason 'native transcript contains the original prompt' --json
imp agent resolve-intent JOB_ID steer-key \
  --reason 'native transcript proves delivery; retire uncertainty' --json
```

Keep caller keys after lost replies. Reconcile observes; it does not replay an
uncertain mutation. Cancel is durable intent, not a cancelled verdict. Settlement
is controller judgment after inspection and is not agent self-proof.

Agent availability per exact enrolled route and machine is separate state, and
dispatch always enforces it in the resident:

```sh
imp agent policy show --json
imp agent policy on tiamat-responses-account/model-id on
imp agent policy override tiamat-responses-account/model-id worker-a allow
imp agent policy fallback tiamat-responses-account/model-id deny
imp agent policy clear-override tiamat-responses-account/model-id worker-a
```

`effective(machine) = !on ? deny : (override[machine] ?? fallback)`; absence is
deny. Policy can only further restrict enrollment — it can never grant an
unenrolled route, machine or harness — and there is no bypass flag on
`dispatch`. `--revision REV` makes the resident's compare-and-set explicit.
See `docs/familiar-agents-v1.md`.

## `imp attn`

Attention tracks Kevin's jots for today, cards on per-project boards, and a
glance at what is running. It is specified in familiar-ui's
`ATTENTION.md`; `imp attn` only shapes the request and prints the result.
Commands are Herdr-style noun/verb pairs and the wire operation is `noun.verb`:
`project list|get|add|set`, `card list|get|add|set|move|block|unblock|done`,
`note add`, `evidence add`, `agent start|set`, `jot add|list|clear-done`, and
`status`.

```sh
imp attn status
imp attn project list --json
imp attn project add familiar --label Familiar --default-policy ship-tell
imp attn card list --project familiar
imp attn card list --lane review --edge blocked
imp attn card add --project familiar --title 'Build imp attn' --owner kes --summary -
imp attn card get CARD_ID
imp attn card set CARD_ID --policy default
imp attn card move CARD_ID inflight
imp attn card block CARD_ID --reason 'waiting on Kevin'
printf '%s\n' 'go test ok' | imp attn note add CARD_ID --text 'tests pass' --detail -
imp attn evidence add CARD_ID --kind pr --title 'PR 12' --ref https://example/pr/12
imp attn agent start CARD_ID --name JOB_ID --model provider/model --host worker-a --harness pi
imp attn agent set CARD_ID --name JOB_ID --state blocked --question 'merge?'
imp attn jot add --title 'call the bank'
imp attn jot add --title 'look into the flake' --owner kes
imp attn jot list
imp attn jot clear-done
```

`card list` requires `--project` and/or `--lane` and fails locally without one.
Human output is one line per card — `id-prefix  lane  owner  [policy if
diverges]  [!blocked]  age  title` — clipped to 64 rows followed by `… and N
more`. `card get` prints the title, project/lane/owner/policy, summary,
evidence, the short timeline and notes; the raw event log is `--json` only.
Prose flags (`--title`, `--summary`, `--text`, `--detail`) accept a lone `-` to
read stdin (≤ 64 KiB). `note add` carries no author; the resident records it as
Kes. Enumerations (`lane`, `owner`, `policy`, `edge`, evidence `kind`, agent
`state`) are checked locally before any request, and the resident re-validates.

## Private resident contract

`imp` never reads or writes Agents state, and never runs SSH. It connects
only to the absolute Unix socket named by `FAMILIAR_IMP_SOCKET`; there is no
endpoint discovery and no network transport. The socket and its immediate
directory must be owned by the current user and inaccessible to group/other
users.

One small foreground resident extension owns this socket. It has a fixed
allowlist of exactly `agent` and `attn`, routing dynamically to the same-process
handlers at `Symbol.for("familiar.imp.agent.v1")` and
`Symbol.for("familiar.imp.attn.v1")`.
This is a replaceable process-topology detail, not a public API or generic
registry. The socket remains available when an area is absent; that area returns
`unavailable`. The Agents handler exists only while the explicitly authorized
foreground Owner is alive. The concurrent familiar-ui Attention implementation
owns its handler, not another socket.

The client writes one LF-terminated JSON record (at most 1 MiB), reads one
LF-terminated JSON record (at most 1 MiB), requires the server to close, and
uses bounded connect/I/O deadlines.

```json
{"version":1,"area":"agent","operation":"status","args":{"offset":0}}
```

Success and failure envelopes are:

```json
{"ok":true,"result":{}}
{"ok":false,"error":{"code":"unavailable","message":"agent unavailable in this owning Familiar resident"}}
```

Unknown envelope fields, unknown areas, extra records and oversized records fail
closed. Exact Agent wire operations and arguments are:

| operation | args |
| --- | --- |
| `capabilities` | optional `machine` |
| `dispatch` | `key`, `machine`, `harness`, `model`, optional `thinking`, `repo`, `requested_ref`, `task`, `label` |
| `status` | optional `id`, optional `offset` (0–100000; pages contain five jobs) |
| `steer`, `answer` | `id`, `key`, `text` |
| `cancel` | `id`, `key` |
| `reconcile` | none |
| `abandon` | `id`, `reason` |
| `settle` | `id`, `verdict` (`done`, `failed`, `cancelled`), `summary` |
| `resolve-operation` | `id`, `operation` (`workspace`, `launch`, `prompt`), `resolution` (`retry-confirmed-absent`, `prompt-confirmed-delivered`), `reason` |
| `resolve-intent` | `id`, `key`, `reason` |

The resident supplies session attribution; the CLI cannot supply or override it.
The resident enforces enrollment, exact model admission, absolute remote repo,
private-span exclusion, idempotency, uncertainty fences, bounded status and
typed native attach hints. Missing ownership/configuration is explicit and has
no local fallback.

Attention wire operations and arguments (the CLI sends exactly these keys, and
only when given):

| operation | args |
| --- | --- |
| `project.list` | optional `hidden` |
| `project.get` | `slug` |
| `project.add`, `project.set` | `slug`, optional `label`, `default_policy`, `repo` |
| `card.list` | `project` and/or `lane` (one required), optional `owner`, `edge`, `q` |
| `card.get`, `card.unblock` | `id` |
| `card.add` | `project`, `title`, optional `lane`, `summary`, `owner`, `policy` |
| `card.set` | `id`, optional `title`, `summary`, `owner`, `policy` (`null` from `--policy default`) |
| `card.move` | `id`, `lane` |
| `card.block` | `id`, `reason` |
| `card.done` | `id`, `done` (`false` with `--undo`) |
| `note.add` | `card`, `text`, optional `detail` |
| `evidence.add` | `card`, `kind`, `title`, optional `ref`, `meta` (JSON object) |
| `agent.start` | `card`, `name`, optional `model`, `host`, `harness` |
| `agent.set` | `card`, `name`, `state`, optional `question` |
| `jot.add` | `title`, optional `owner` |
| `jot.list`, `jot.clear-done`, `status` | none |

The resident may answer a list with a bare array or `{items|cards, total,
truncated}`; the CLI honours `total`/`truncated` in its `… and N more` footer and
never prints more than 64 rows either way.

Exit statuses are 0 success, 2 usage, 3 missing resident capability, 4 a
resident-declared failure, and 5 local transport/protocol failure. Diagnostics
go to stderr. Output has no pager or terminal styling.

## Development

```bash
go test ./...
go build ./cmd/imp
```
