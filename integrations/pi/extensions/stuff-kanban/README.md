# Stuff Kanban

A projectable Familiar Pi extension providing a batch-scoped, keyboard-driven Stuff board.

## Use

```text
/stuff-kanban [batch-item-id]
```

The batch defaults to `STUFF_KANBAN_BATCH`, then to
`item_uy26qlk42ra4xtkeih2skgtjwa`. The extension uses the installed `stuff` CLI
and its existing `STUFF_URL`, `STUFF_TOKEN`, and `STUFF_TOKEN_FILE`
configuration. It reads `batch.metadata.item_ids`, fetches each Item, and groups
cards by `metadata.status` into `open`, `in_progress`, `ready_for_review`, and
`done`. Missing or unrecognized statuses display as `open` without being
written.

Keys:

- arrows or `h/j/k/l`: select a lane/card
- `enter`: toggle the selected Item's details and metadata
- `[` / `]`: move to the preceding/following lane
- `o`: open the Item in the Stuff web reader
- `q`, `esc`, or `ctrl-c`: close

Moves preserve the complete metadata object and call `stuff update --revision`
with the revision loaded for that card. A conflict fails visibly instead of
retrying or overwriting concurrent work. Items with non-object metadata or no
revision are viewable but fail closed for moves.
