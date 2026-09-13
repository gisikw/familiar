# Subconscious reminders

Notes the outgoing Familiar leaves for the next one at a `/clear` boundary, and
then cannot look at again. Each surfaces later on its own, once, as a hidden
system reminder in the middle of ordinary conversation.

## Sequence

```
/clear
  ├─ handoff inference         outgoing model, full context → handoff (archived)
  ├─ curation inference        same model, same context + the handoff → strict JSON
  │                            ephemeral: nothing sent, nothing appended
  └─ compaction                the handoff alone becomes the compaction entry
orientation, then ordinary turns
  └─ before_agent_start        at most one reminder per human turn, hidden, then gone
```

The curation request runs inside `session_before_compact`, after the handoff
archive is written and before the handler returns — the only seam where the
handoff exists *and* the outgoing context is still whole. Its messages are the
handoff request plus the handoff as an assistant turn plus one user ask. Nothing
from it touches the session: no `sendMessage`, no `appendEntry`, and the
returned compaction is the handoff verbatim. The next Familiar has no memory of
the turn; she meets the reminders only when they arrive.

Only Familiar's own `/clear` (command or `clear` tool) curates. The automatic
90% handoff, native `/compact`, and overflow retries produce a handoff without
curation. One `/clear` is at most one dispatch, consumed before anything can
fail.

## Reply schema

Exactly one bare JSON object, with no markdown fences or prose:

```json
{"ops":[]}
```

or exactly one operation:

```json
{"ops":[{"op":"add","text":"…","curve":{"turns":[2,40],"hours":[6,168],"chance":[0.02,0.45]}}]}
{"ops":[{"op":"set","id":"r-…","text":"…","curve":{"turns":[2,40],"hours":[6,168],"chance":[0.02,0.45]}}]}
{"ops":[{"op":"remove","id":"r-…"}]}
```

`add`, `set` (either text or curve), and `remove` are the available mutations.
Replacement takes two `/clear` boundaries; store capacity remains 8 across all
sessions. `{"ops":[]}` is a normal answer and changes nothing. Validation is
strict and all-or-nothing: prose, wrappers, unknown ops or keys, bad ids, an
unknown id, **more than one operation**, more than 400 characters of text, or
more than 8 resulting reminders reject the whole reply. Multi-operation replies
are never truncated. Anything rejected — along with a provider error, a thrown
failure, an abort, or the 30 s timeout
(`FAMILIAR_SUBCONSCIOUS_TIMEOUT_MS`) — is logged as a stage name only and
`/clear` completes with the set untouched. Interrupting the compaction while
curation is in flight cancels the whole `/clear` (Pi cancels a manual compaction
whose signal aborted inside the hook), so the timeout — not the user — is the
bound that keeps an unresponsive model from holding a `/clear` open.

## Delivery

Each reminder persists its author's compact curve: `turns` and `hours` are
`[quietUntil, fullyMatureAt]` ranges, while `chance` is the per-eligible-turn
`[near, mature]` probability. Turn and wall-clock progress are independently
clamped and averaged, then probability is linearly interpolated between the
chance bounds. The contract is bounded and monotonic, but not a delivery
promise: a mature chance may remain below 1.

An eligible turn is one that entered through the input hook while no handoff is
running and orientation is over. Pending reminders are evaluated in persisted
order. The scan stops immediately at the first stochastic success, so at most
one surfaces in a turn. There is deliberately no refractory period, session
budget, handoff gate, or turn cliff; reminders can naturally arrive on adjacent
turns. A surfaced reminder is removed from the store before it is
injected as a hidden `subconscious-reminder` message (`display: false`, no
renderer) carrying its text, age, originating session, and handoff archive.
That message is ordinary session context for the Familiar who received it.
Delivery is at-most-once: a crash between the write and the model seeing it
loses that reminder rather than repeating it.

## Storage

One file, `reminders.json`, under `FAMILIAR_SUBCONSCIOUS_DIR` (default
`$STATE_DIR/subconscious`, 0700; fallback the `subconscious` sibling of
`PI_CODING_AGENT_DIR`). Replaced atomically (0600 temp, fsync, rename). A file
that fails validation reads as empty and is renamed `*.corrupt` rather than
overwritten in place. Bodies are plaintext; the running Familiar has no tool,
command, or renderer that reads the file, but a `bash` child on this host can.

Schema v2 stores authored curves directly. Deployed schema-v1 records hydrate
without reading their bodies for migration logic and receive bounded defaults
based on their old priority; they are not eagerly rewritten. Their next normal
store mutation or draw atomically persists the whole file as v2. Defaults are:
`high` `[1,40]` turns / `[6,168]` hours / `[.15,.5]` chance; `normal`
`[5,200]` / `[24,720]` / `[.03,.25]`; `low` `[20,600]` / `[168,2160]` /
`[.01,.1]`. Unlike the old turn cliff, none creates a delivery guarantee.

Each write replaces the file atomically, but a draw is read-modify-write with no
lock: the store assumes the single resident Familiar of one `STATE_DIR`. Two
processes sharing a store could lose or repeat a reminder. The curation request
is a direct `modelRegistry.complete()` call, so its tokens are billed by the
provider but never appear in Pi's session usage or cost display; it is bounded
by one dispatch, a 2048-token reply (uncapped only where the provider rejects
`max_output_tokens`), and the 16 KiB parse ceiling.

## Tests

`nix develop -c bun test handoff/` from `integrations/pi/extensions`.
`subconscious.test.ts` covers the schema, application, store, curve, and the
ephemeral request in isolation; `clear-curation.test.ts` drives the real
extension through a fake pi and proves ordering, outgoing-model ownership,
non-persistence, gating of non-`/clear` compactions, every failure mode, and
hidden delivery.
