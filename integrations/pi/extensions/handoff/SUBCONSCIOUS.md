# Subconscious seeds

At an explicit `/clear`, the outgoing Familiar may author one attentional seed
(or none) for a future self. This is not another handoff, task queue, or command:
the receiving Familiar retains judgment about whether and how to act. Seeds can
carry a forgotten joke setup, held-back thought, question, promise, warning,
provocation, or encouragement.

## Sequence

```text
/clear
  handoff inference   full outgoing context → handoff
  curation inference  same context + handoff → strict JSON (ephemeral)
  compaction          handoff alone enters the Pi session
ordinary input
  before_agent_start  at most one seed surfaces, hidden, then is removed
```

Only Familiar's command/tool `/clear` curates. Automatic 90% handoffs, native
`/compact`, and overflow retries do not. Curation is one direct
`modelRegistry.complete()` call from `session_before_compact`; its messages and
usage never enter Pi's session. Failure, abort, malformed output, or the bounded
30-second timeout changes no reminders and does not prevent compaction.

## Reply and delivery

The reply is exactly one bare JSON object with zero or one operation:

```json
{"ops":[]}
{"ops":[{"op":"add","text":"…","curve":{"turns":[2,40],"hours":[6,168],"chance":[0.02,0.45]}}]}
{"ops":[{"op":"set","id":"r-…","text":"…"}]}
{"ops":[{"op":"remove","id":"r-…"}]}
```

Validation is strict and all-or-nothing. There are at most eight seeds, one
mutation per clear, 400 characters per seed, and a 16 KiB response ceiling.
Each curve gives quiet/mature ranges for turn age and wall-clock hours plus
near/mature per-turn probabilities. Their clamped progress is averaged, so
probability matures monotonically but delivery is never promised.

On each eligible ordinary human turn, records age in persisted order and the
scan stops at its first stochastic success. The selected record is removed
before its hidden `subconscious-reminder` is injected, giving at-most-once
delivery. The reminder displays its originating session and handoff compaction
entry id. Deployed records with the former handoff file path remain valid and
display that legacy origin.

## Storage and tests

`reminders.json` lives under `FAMILIAR_SUBCONSCIOUS_DIR` (default
`$STATE_DIR/subconscious`, fallback beside `PI_CODING_AGENT_DIR`). The 0700
directory contains one atomically replaced 0600 file. Invalid data reads empty
and is renamed `*.corrupt`. Schema-v1 priority records hydrate with bounded
legacy curves; schema v2 stores curves directly. The store assumes one resident
writer.

Run `nix develop -c nix shell nixpkgs#bun -c bun test
integrations/pi/extensions/handoff`.
