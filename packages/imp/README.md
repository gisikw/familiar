# `imp`

`imp` is Familiar's private, CLI-shaped model tool. It is not a public Familiar
administration CLI. Familiar adds it to `PATH` only in the process environment
used to launch its resident Pi, so Pi's model-callable Bash children inherit it.
A normal shell and the other Familiar service shells do not.

Run `imp --help`, then `imp plate --help` or `imp agent --help`, for progressive
command discovery. Human-readable output is concise and bounded; every command
accepts `--json`. Commands which take prose accept a lone `-` in place of their
prose option and read stdin. Agent tasks are limited to 24 KiB, Agent text and
summaries to their existing 4–8 KiB bounds, and Plate prose to 64 KiB.

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

## Private resident contract

`imp` never reads or writes Plate or Agents state, and never runs SSH. It connects
only to the absolute Unix socket named by `FAMILIAR_IMP_SOCKET`; there is no
endpoint discovery and no network transport. The socket and its immediate
directory must be owned by the current user and inaccessible to group/other
users.

One small foreground resident extension owns this socket. It has a fixed
allowlist of exactly `plate` and `agent`, routing dynamically to the same-process
handlers at `Symbol.for("familiar.imp.plate.v1")` and
`Symbol.for("familiar.imp.agent.v1")`. This is a replaceable process-topology
detail, not a public API or generic registry. The socket remains available when
an area is absent; that area returns `unavailable`. The Agents handler exists
only while the explicitly authorized foreground Owner is alive. The concurrent
familiar-ui Plate implementation owns the Plate handler, not another socket.

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

Plate operations retain their existing wire contract:

| operation | args |
| --- | --- |
| `list` | `archived: boolean` |
| `get` | `id` |
| `add` | `summary`, optional `label`, `assignedToKes`, `accent` |
| `update-summary` | `id`, `summary` |
| `set-label` | `id`, `label` |
| `clear-label` | `id` |
| `append-note` | `id`, `text` |
| `assign` | `id`, `assignedToKes` |
| `set-accent` | `id`, `accent` |
| `clear-accent`, `close`, `restore` | `id` |

`append-note` carries no authorship field. The owning resident attributes it to
Kes.

Exit statuses are 0 success, 2 usage, 3 missing resident capability, 4 a
resident-declared failure, and 5 local transport/protocol failure. Diagnostics
go to stderr. Output has no pager or terminal styling.

## Development

```bash
go test ./...
go build ./cmd/imp
```
