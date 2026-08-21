# Worklist + Attention protocol

The **worklist** is a durable, referable collection of *out-of-band* work for
the foreground pi agent: subagent settlements, cron wakeups, monitoring alerts,
self-authored reminders/prompts, questions, and opportunities. **Attention** is
the policy that governs *when* a worklist item may surface into the live
conversation.

The worklist is **not** email, **not** the durable ticket/task system, and
**not** user-message transport. It exists because pi's message injection is
**push-only**: nothing lets an extension catch an injected message and defer it
(RESEARCH-inbox-feasibility.md). So it works by **convention**: senders *enqueue
here* instead of calling `pi.sendMessage` directly, and this extension owns
*when* and *how* each item reaches the conversation.

> **Architectural sev0.** Real user messages and tool results NEVER pass
> through the worklist. That is a property of the architecture, not a policy
> knob. The worklist is only for out-of-band senders.

Design principles it implements (state/docs/presence.md):
- *Conversational surfacing is a courtesy, not the tracking mechanism.* The
  durable queue is the source of truth; delivery is a layer on top.
- Pressure is *a hum, not an alarm* — ignorable by the foreground agent.
- The foreground model NEVER triages its own worklist. Priority is set by the
  sender (or a future classifier); the extension's timer does the delivery.

---

## Queue item

```jsonc
{
  "id": "wl-20260821-053300-a1b2",   // minted, or caller-supplied for idempotency
  "ts": 1755680000000,                // enqueue time (ms epoch)
  "priority": 2,                      // 0..3, lower = more urgent
  "type": "notify",                   // notify | question | review
  "summary": "Emerson account",       // short — for nudges + widget
  "body": "full content…",            // delivered on ack / auto-ack
  "source": "remind",                 // who enqueued it
  "suggested_deadline": 1755690000000,// optional, advisory (see Escalation)

  // delivery state (extension-owned, persisted with the item):
  "delivered": false, "acked": false, "surfacedCount": 0,
  "escalated": false, "digested": false, "snoozedUntil": null,
  "withdrawn": false                  // claimed elsewhere; never surfaces (see Dedup)
}
```

Persisted one-file-per-item under `state/worklist/`:

```
state/worklist/
  items/<id>.json           the live queue (one file = atomic, lock-free)
  items/archive/<id>.json   acked/resolved/withdrawn items (audit survives)
  incoming/<id>.json        cross-process drop-box (drained on the timer)
  attention.json            { mode, override: { level, expiresAt } | null }
```

One-file-per-item (not a shared jsonl) because senders are concurrent and
out-of-process: a temp-write+rename per file is atomic without a lock. A torn
jsonl append would corrupt the whole queue; a torn item file is one skippable
item. Survives `/reload`, `/new`, `/fork`, and crashes because it is on disk.

---

## Attention — four levels

Four channel states, **visible at all times in pi's footer**, ordered by
*decreasing* interruptibility:

| Level | Glyph | Meaning | Origin |
|-------|-------|---------|--------|
| **open** | ○ | Long-unoccupied; pull *anything* queued rather than sit idle. | inferred only |
| **available** | ◐ | Ordinary availability; important items surface, trivia waits for a lull. | inferred or manual pin |
| **focused** | ◑ | Active/recent conversation; suppress ordinary interruptions. | inferred or manual pin |
| **protected** | ● | Explicit, **time-bounded** total suppression; hold everything incl. P0 until expiry or manual release. | **manual only, always timed** |

`open | available | focused` are auto-inferred from activity. `protected` (and a
manual *pin* of `available`/`focused`) can only be set **with a duration**.
`open` can never be entered manually — it is an earned idle state.

### The one hard invariant

**Every manual override carries an expiry; on expiry the level returns directly
to auto-inference. No decay.** The override is clamped to `maxOverrideMs` (8h),
so nothing manual can be unbounded. `expiresAt` is absolute wall-clock, written
atomically to `attention.json`, so a `/protect 30m` set at 14:00 survives a
crash at 14:10 and still expires at 14:30; an already-expired override is
discarded on load. Expiry is **lazy**: `resolveAttention` compares `now` to
`expiresAt` on every read, so correctness never depends on a timer firing.

### Inference (auto mode)

- agent working **or** activity within `settleToAvailableMs` (2 min) → **focused**
- activity within `settleToOpenMs` (30 min) → **available**
- longer idle → **open**

A fresh/reloaded session reseeds activity so it starts **focused** until it
settles — safer than dumping the queue into a just-resumed agent.

---

## Delivery tiers

Ordered most-active → most-passive. A tier is *how* an item reaches the
conversation, never *whether* it is tracked.

| Tier | Behavior |
|------|----------|
| **steer** | deliver ASAP via `deliverAs:"steer"` + `triggerTurn`. **Auto-acks.** |
| **nudge** | inject a one-line summary prefix into the NEXT turn; full body only on `/ack`. Rides `before_agent_start`. |
| **wait** | deliver + auto-ack only after settled ≥ `waitSettleMs` (5 min) AND attention allows. Focused holds entirely. |
| **linger** | never delivered individually. A single digest line for ALL lingering items after sustained idle (5 min) or on `/peek`. |

### Priority × attention matrix (the full policy)

| Priority | open (solicit) | available | focused | protected |
|----------|----------------|-----------|---------|-----------|
| **P0** | steer | steer | steer | **hold** |
| **P1** | steer | nudge | wait→hold | **hold** |
| **P2** | nudge | wait | linger→hold | **hold** |
| **P3** | wait | linger | linger→hold | **hold** |

- **open** promotes one tier (except P0, already steer): idle pulls work forward.
- **available** is the base mapping.
- **focused** demotes one tier except P0; `wait`/`linger` then *hold entirely*.
- **protected** is a total floor: **all → hold**, P0 included, the "driving
  home" guarantee. The queue stays durable; delivery resumes on expiry. This is
  the one column unreachable by inference.

The mapping lives in a plain config table (`DEFAULT_CONFIG` in `policy.ts`) and
is a pure function of `(item, attention, clock, config)`, so the whole matrix is
headlessly testable (`worklist.test.ts`).

### Escalation

If `suggested_deadline` passes, the item is **promoted one tier, once**
(latched via `escalated`), applied *before* the attention transform. A
`protected` level still forces `hold` afterward — protected genuinely means
protected; the only escape is expiry or manual release.

---

## Commands

| Command | Effect |
|---------|--------|
| `/peek` | Queue snapshot (id, priority, type, age, resolved tier, summary). |
| `/ack [id\|all]` | Acknowledge nudged item(s); inject full body and resolve. |
| `/remind <text> [--in <dur>\|--at <time>]` | Enqueue a self-reminder (P2). |
| `/attention [auto\|available\|focused\|protected] [duration]` | Show or set attention. Non-`auto` levels REQUIRE a duration (always time-bounded); `auto` releases. |
| `/protect <duration>` | Headline DND: hold ALL items (even P0) for a duration, then auto-resume. Shorthand for `/attention protected <duration>`. |
| `/snooze <id> <duration>` | Suppress a single item until the duration elapses. |

Autocomplete populates the `description` field so the menu teaches the policy
(e.g. `protected — total do-not-disturb, time-bounded, queue stays durable`) and
duration hints compute the live resume time.

## Model-callable tool

`set_attention({ level, duration_minutes? })` — Exo can protect the conversation
herself. Any non-`auto` level requires `duration_minutes` and is clamped; the
tool can never set an unbounded state. Returns the resolved `expires_at`.

Command, tool, and restart all funnel through one internal `setOverride(level,
durationMs)` that clamps, persists, and repaints.

---

## Enqueue paths

### (a) In-process — the shared event bus (fire-and-forget)

```ts
pi.events.emit("worklist:add", { priority: 1, summary: "build failed", … });
```

No import cycle. **This is fire-and-forget only** — `pi.events.emit` returns
`void` and gives no acceptance guarantee, so it is not used for the subagent
seam. The old `inbox:add` channel is kept as a bounded compatibility alias for
one release.

### (b) Out-of-process — the drop-box (marker-file pattern)

```sh
familiar.sh worklist-add --summary "Emerson followup" --priority 1 [--body …]
```

writes an atomic envelope to `state/worklist/incoming/<id>.json`, drained on the
timer. `familiar.sh inbox-enqueue` remains as a bounded alias for one release.
Drain is **idempotent on stable id**: a drop whose id already exists (live or
archived) is discarded, never duplicated.

### (c) The subagent durable-sink capability — the exactly-once seam

The **subagent extension is the first real client**, and it does NOT use (a) or
(b): it needs a *durable acceptance handshake* so it knows whether to suppress
its own direct relay. See the next section.

---

## Subagent settlement routing (candidate 4)

Neither extension imports the other. Both depend only on a tiny neutral,
versioned, process-local registry: `extensions/lib/capabilities.ts`.

- **Worklist registers** a versioned async durable-enqueue **sink**
  (`worklist.durable-sink@1`) in `session_start` (disposed + re-registered
  across `/reload`, so it is restart-safe).
- **Subagent resolves** the sink at courtesy-delivery time (never at load). If
  present, it `await`s `sink.enqueue(envelope)` and only suppresses its own
  direct relay when the sink returns `{ accepted: true }`. If the sink is
  **absent, returns `accepted:false`, or throws**, subagent falls back to its
  direct `pi.sendMessage` steer relay. This preserves independent usability:
  subagents work with the worklist absent, and the worklist stays generic.
- Settlement urgency: `crashed`/`timeout` → P1, `cancelled`/`done` → P2. Blocked
  questions remain a direct interrupt (they are not settlements).

### Exactly-once delivery + the await/queued dedup invariant

Three delivery channels exist for a settlement: the background **relay** (via
sink or direct), an explicit **`subagent_await`** join, and **`subagent_cancel`**.
Exactly one may ever surface a given `(id, pass)`.

- The `relayed-<pass>` marker file arbitrates ownership: whoever claims it owns
  delivery; the losing channel does nothing.
- **The race the brief calls out:** a settlement is already queued in the
  worklist (relay routed it through the sink) and then `subagent_await` claims
  it. Without care it could surface twice — once from the worklist timer, once
  from the tool result.

  **Invariant:** *a settlement claimed by `subagent_await` is withdrawn from the
  worklist before its verdict is returned, and can never subsequently surface.*

  Implementation:
  1. Relay enqueues with a **stable, pass-scoped id** (`subagent-<id>-<pass>`)
     and writes a `worklisted-<pass>` marker.
  2. `subagent_await`, on finding the settlement, calls `sink.withdraw(id)`
     *before* returning:
     - `withdraw` → **true** (item undelivered, or not yet present): the item is
       marked `withdrawn` (terminal, never delivered) and archived. The tool
       result is now the single surface.
     - `withdraw` → **false** (item already `delivered`/`acked` by the worklist):
       await does **not** repeat the body; it returns a pointer to the prior
       delivery instead.
  3. **In-flight race** (await withdraws while relay's `enqueue` is still
     pending): `withdraw` sets an in-memory **tombstone** for the id *first*, so
     the late `enqueue` resolves `{ accepted: false, superseded: true }`. On
     `superseded`, relay keeps the `relayed` marker and does **not** fall back to
     a direct relay — delivery is already owned. This closes the race in both
     orderings.

Tested in `extensions/lib/capabilities.test.ts` (duplicate-prevention suite) and
`extensions/worklist/worklist.test.ts` (store withdraw/dedup).

---

## Widget

A widget appears **IFF the worklist is non-empty**: `📋 <count> (P<top>)`. During
a `protected` override it shows the held count + countdown so suppression is
legible: `📋 3 held (P0) · protected 24m`.

Attention rides the footer via `ctx.ui.setStatus("attention", …)` — the intended
multi-extension footer-status mechanism (shared with `ratelimit.ts`) — with a
live countdown recomputed each repaint while an override holds.

---

## Files

```
extensions/lib/capabilities.ts    neutral versioned registry + sink contract
extensions/worklist/
  policy.ts        pure decision core (tiers, attention, escalation, clamp) — no I/O
  store.ts         durable queue + atomic writes + drop-box drain + migration — I/O only
  index.ts         extension: hooks, timer, commands, tool, delivery, surfaces, sink
  worklist.test.ts headless tests (bun) for policy + store + parse
  PROTOCOL.md      this file
```

Tests: `nix develop .#stt -c bun test extensions/worklist/worklist.test.ts extensions/lib/capabilities.test.ts`
(bun lives in the `.#stt` dev shell; there is no `node` in `.#pi`).

---

## Migration from `inbox`

- Directory `extensions/inbox/` → `extensions/worklist/` (git mv, history kept).
- State dir `state/inbox/` → `state/worklist/`; a one-shot migration on first
  `ensureDirs()` copies legacy `items/`, `items/archive/`, `incoming/` and
  translates `posture.json` → `attention.json`. A legacy permanent `busy` is
  **dropped to `auto`** — nothing unbounded is carried across the rename. No
  queued item is ever lost.
- Env: `FAMILIAR_WORKLIST_DIR` (canonical) falls back to `FAMILIAR_INBOX_DIR`
  (bounded, one release).
- CLI: `familiar.sh worklist-add`; `inbox-enqueue` kept as a bounded alias.
- Event: `worklist:add`; `inbox:add` kept as a bounded alias.
- Commands: `/posture` → `/attention` + `/protect`. Widget/status keys
  `worklist` / `attention`. Custom message types `worklist-item`/`-nudge`/`-digest`.

Aliases are for exactly one release; drop them after.
