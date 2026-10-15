# l1 — Kes's L1 fast memory

A small, bounded, typed fact cache. Not a memory system: the session record
stays the source of truth. L1 is the cache that makes the right fact show up
the first time a name comes up, and keeps itself true from Kev's own words.

## Shape

- **SQLite** at `$FAMILIAR_STATE_DIR/l1/l1.db` (0600). Entities (with aliases
  and a kind) and edges `(entity, attribute, value)` with a source quote,
  timestamps, `last_hit`, `hit_count`. Every change is logged in `changes`.
- **Closed vocabulary.** Attributes: `relation role employer former_employer
  location age born author status origin link`. Kinds: `person org place work
  project concept other`. If a fact doesn't fit a slot, it isn't L1.
- **Pinned core** (Kev, Ash, Cian, Auden, Brighton) is never evicted.

## Loops

| when | what | evidence |
|---|---|---|
| every human turn | `l1 cue`: entities first-mentioned this session → one hidden gloss line each (≤3) | lexical alias match |
| after a handoff lands | `l1 revise`: for entities Kev mentioned since last revision, keep/update/retract each edge; one check for a new fact in an empty slot | **Kev's turns only** (merges, notices, reminders, briefs stripped) |
| at a handoff | intake: a separate model call over the outgoing context nominates ≤5 facts; `l1 nominate` vets each | Kev's turns + primary documents (tool results), never Kes's own prose |
| after revise | `l1 decay --target 150`: evict lowest `(hits+1)/(1+days_since_hit/7)`, pinned exempt | — |
| after revise/intake | `l1 asks`: below-threshold changes become **staged** Attention asks (Yes/No); resolutions are applied next run | Kev |

## Decider

System-One style, local: a fleet vLLM (default `[llama] base_url`, model
`qwen3.8-27b`). A decision is one forward pass with output constrained to
option letters; confidence is the softmax over those letters' logprobs.
Values are extracted with JSON-schema-constrained output. No conversation
content goes to a hosted API.

Policy: confidence ≥ `l1_threshold` (0.9) **and** a supporting quote →
applied and logged. 0.6–0.9 → staged ask. Below 0.6 → treated as keep.

## Config

`[familiar] l1_enabled = true` turns on the Pi extension
(`integrations/pi/extensions/l1`). Optional: `l1_db`, `l1_decider_url`, `l1_systemone_url` (native `/v1/systemone` decision model for choices),
`l1_decider_model`, `l1_threshold`, `l1_target`.

## CLI

```
l1 show [ENTITY]           l1 log --since 24h
l1 set ENTITY ATTR VALUE [--kind K] [--pin] [--alias a,b]   (empty VALUE retracts)
l1 replay --session-file F --since 72h    # dry run on a scratch copy; prints a report
l1 seed --glossary ~/Projects/hoard/macros/glossary          # one-time import
```

Tests: `nix build .#l1` (runs `go test`), and
`nix develop -c nix shell nixpkgs#bun -c bun test integrations/pi/extensions/l1`.
