# `imp`

`imp` is Familiar's private, CLI-shaped model tool. It is not a public Familiar
administration CLI. Familiar adds it to `PATH` only in the process environment
used to launch its resident Pi, so Pi's model-callable Bash children inherit it.
A normal shell and the other Familiar service shells do not.

Run `imp --help`, then `imp plate --help`, for progressive command discovery.
Human-readable output is the default; every command accepts `--json`. Commands
which take prose accept a lone `-` in place of their prose option and read up to
64 KiB from stdin.

## Private resident contract

`imp` never reads or writes Plate state. It connects only to the absolute Unix
socket named by `FAMILIAR_IMP_SOCKET`; there is no endpoint discovery and no
network transport. The socket and its immediate directory must be owned by the
current user and inaccessible to group/other users.

The client writes one LF-terminated JSON record (at most 1 MiB), reads one
LF-terminated JSON record (at most 1 MiB), requires the server to close, and
uses bounded connect/I/O deadlines.

```json
{"version":1,"area":"plate","operation":"list","args":{"archived":false}}
```

Success and failure envelopes are:

```json
{"ok":true,"result":{}}
{"ok":false,"error":{"code":"not_found","message":"no such item"}}
```

Unknown fields in the response envelope fail closed. Wire operation names and
arguments are deliberately the same as the discoverable command names:

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

`append-note` intentionally carries no authorship field. The owning resident
must attribute this ingress to Kes. The resident remains authoritative for
schema bounds, sorting, timestamps, concurrency, and all state mutation.

Exit statuses are 0 success, 2 usage, 3 missing resident capability, 4 a
resident-declared failure, and 5 local transport/protocol failure. Diagnostics
go to stderr. Output has no pager or terminal styling.

## Development

```bash
go test ./...
go build ./cmd/imp
```
