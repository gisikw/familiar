# `imp`

`imp` is Familiar's private, CLI-shaped model tool. It is not a public Familiar
administration CLI. Familiar adds it to `PATH` only in the process environment
used to launch its resident Pi, so Pi's model-callable Bash children inherit it.
A normal shell and the other Familiar service shells do not.

Run `imp --help`, then `imp attn --help` or `imp schedule --help`, for command discovery.
Human-readable output is concise and bounded; every command accepts `--json`.
Commands which take prose accept a lone `-` in place of their prose option and
read stdin. Attention prose is limited to 64 KiB.

## `imp attn`

Attention tracks Kevin's jots for today, cards on per-project boards, and a
glance at what is running. It is specified in familiar-ui's
`ATTENTION.md`; `imp attn` only shapes the request and prints the result.
Commands use noun/verb pairs and the wire operation is `noun.verb`:
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
It lists newest first (`--order updated`, the default; `created` for newest
capture first, `lane` for the board's order) and one page at a time:
`--offset N`, `--limit N` (1-64, default 64), and `--since TIME` /
`--created-since TIME` to keep only cards touched or created since then (a
duration back like `6h` or `2d`, `today`, `yesterday`, `YYYY-MM-DD`, or RFC3339).
Human output is one line per card — `id-prefix  lane  owner  [policy if
diverges]  [!blocked]  age  title` — followed by `… and N more (next:
--offset M)` when another page exists. `card get` prints the title, project/lane/owner/policy, summary,
evidence, the short timeline and notes; the raw event log is `--json` only.
Prose flags (`--title`, `--summary`, `--text`, `--detail`) accept a lone `-` to
read stdin (≤ 64 KiB). `note add` carries no author; the resident records it as
Kes. Enumerations (`lane`, `owner`, `policy`, `edge`, evidence `kind`, agent
`state`) are checked locally before any request, and the resident re-validates.

## Scheduler

The scheduler commands connect directly to `FAMILIAR_SERVICES_SOCKET` (default
`/run/familiar-services/familiar.sock`). `imp` copies its inherited
`FAMILIAR_INSTANCE_ID` into every request as `origin`; callers never provide an
origin themselves. Future and due-now events share the same model:

```sh
imp schedule --in 30m 'check deployment'
imp schedule --at 2026-10-01T09:00:00Z --target instance:SESSION --soft 'follow up'
imp schedule list
imp schedule cancel EVENT_ID
imp notify --id stable-settlement-id --soft 'job finished'
imp dnd on 30m
imp dnd disturb        # Do Disturb: quiet fork returns wake me; until local midnight (or `disturb 4h`)
imp dnd status
imp dnd off
```

## Host runs

`imp host run <host> <script> "reason"` asks a host's page
(`https://<host>.fort.<domain>/runs/<id>`) to run a script as root once Kev
approves it with his passkey. It prints the run's URL, pushes it to Kev's
phone (reason, check code, URL), starts a watcher (a transient systemd unit, so it
outlives a merging fork), then blocks: up to 5 minutes for approval, then
through the run, and prints the result. On timeout it returns "still
pending" and the watcher hard-notifies the asking instance when the run is
done, failed, rejected or expired, carrying exit code, trimmed output and the
folder with the full output. `--async` skips the blocking. A `delivered`
marker (O_EXCL) in `$FAMILIAR_STATE_DIR/host-runs/<host>-<id>/` makes sure only
one of them hands the result over; the watcher defers while the blocking
call's `blocking` lease is fresh. The client is `$FAMILIAR_HOST_CLIENT` (default
`$FAMILIAR_STATE_DIR/bin/fortress-keeper`, which signs with Kes's key).

## Private Attention resident contract

`imp` connects only to the absolute Unix socket named by `FAMILIAR_IMP_SOCKET`; there is no
endpoint discovery and no network transport. The socket and its immediate
directory must be owned by the current user and inaccessible to group/other
users.

One small foreground resident extension owns this socket and routes Attention
to the same-process handler at `Symbol.for("familiar.imp.attn.v1")`. This is a
replaceable process-topology detail, not a public API or generic registry. The
concurrent familiar-ui Attention implementation owns its handler, not another
socket.

The client writes one LF-terminated JSON record (at most 1 MiB), reads one
LF-terminated JSON record (at most 1 MiB), requires the server to close, and
uses bounded connect/I/O deadlines.

```json
{"version":1,"area":"attn","operation":"status","args":{}}
```

Success and failure envelopes are:

```json
{"ok":true,"result":{}}
{"ok":false,"error":{"code":"unavailable","message":"attn unavailable in this owning Familiar resident"}}
```

Unknown envelope fields, unknown areas, extra records and oversized records fail
closed. Attention wire operations and arguments (the CLI sends exactly these keys, and
only when given):

| operation | args |
| --- | --- |
| `project.list` | optional `hidden` |
| `project.get` | `slug` |
| `project.add`, `project.set` | `slug`, optional `label`, `default_policy`, `repo` |
| `card.list` | `project` and/or `lane` (one required), optional `owner`, `edge`, `q`, `order` (`lane` default on the wire; the CLI sends `updated`), `offset`, `limit` (1-64), `since`, `created_since` (RFC3339) |
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
truncated}` (paged `card.list` adds `offset`); the CLI honours `total`/`truncated` in its `… and N more` footer and
never prints more than 64 rows either way.

Exit statuses are 0 success, 2 usage, 3 missing resident capability, 4 a
resident-declared failure, and 5 local transport/protocol failure. Diagnostics
go to stderr. Output has no pager or terminal styling.

## Development

```bash
go test ./...
go build ./cmd/imp
```
