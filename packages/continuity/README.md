# @familiar/continuity

Familiar-owned continuity models and a replaceable file-backed store. This is separate from pi transcripts/session state.

## Layout

```text
<root>/
  canon/<id>.json
  handoffs/<id>.json
  preferences/<deviceId>--<clientId>.json
```

JSON records carry Markdown in `body`; this preserves prose without making front matter a second schema. IDs use a bounded filename-safe alphabet. Direct reads validate and report corruption; lists isolate a malformed record so one damaged file cannot hide all continuity.

Every write creates a mode-0600 sibling temp file, writes and `fsync`s it, atomically renames it, then `fsync`s the parent directory. Thus a crash exposes either the old or complete new record, never partial JSON. `FileContinuityStore` accepts test hooks for deterministic crash simulation.

The `ContinuityStore` interface contains no filesystem details so a DB implementation can replace it. `appendCanon` appends Markdown to an existing entry; `appendHandoff` mints an ordered ID. Existing encrypted `identity/*.md.age` must be decrypted/encrypted by the Presence integration during a later migration; this package deliberately does not own key management.
