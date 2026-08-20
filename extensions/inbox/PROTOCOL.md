# Inbox protocol

The **inbox** is an annotated, queued, policy-delivered channel for
*out-of-band* messages to the foreground pi agent — subagent settlements, cron
output, monitoring alerts, self-reminders. It exists because pi's message
injection is **push-only**: nothing lets an extension catch an injected message
and defer it (RESEARCH-inbox-feasibility.md). So the inbox works by
**convention**: senders *enqueue here* instead of calling `pi.sendMessage`
directly, and this extension owns *when* and *how* each item reaches the
conversation.

> **Architectural sev0.** Real user messages and tool results NEVER pass
> through the inbox. That is a property of the architecture, not a policy knob.
> The inbox is only for out-of-band senders.

Design principles it implements (state/docs/presence.md):
- *Conversational surfacing is a courtesy, not the tracking mechanism.* The
  durable queue is the source of truth; delivery is a layer on top.
- Pressure is *a hum, not an alarm* — ignorable by the foreground agent.
- The foreground model NEVER triages its own inbox. Priority is set by the
  sender (or a future classifier); the extension's timer does the delivery.

---

## Queue item

```jsonc
{
  "id": "inbox-20260820-053300-a1b2", // minted, or caller-supplied for idempotency
  "ts": 1755680000000,                // enqueue time (ms epoch)
  "priority": 2,                      // 0..3, lower = more urgent
  "type": "notify",                   // notify | question | review  (langchain agent-inbox)
  "summary": "Emerson account",       // short — for nudges + widget
  "body": "full content…",            // delivered on ack / auto-ack
  "source": "remind",                 // who enqueued it
  "suggested_deadline": 1755690000000,// optional, advisory (see Escalation)

  // delivery state (extension-owned, persisted with the item):
  "delivered": false, "acked": false, "surfacedCount": 0,
  "escalated": false, "digested": false, "snoozedUntil": null
}
```

Persisted one-file-per-item under `state/inbox/`:

```
state/inbox/
  items/<id>.json           the live queue (one file = atomic, lock-free)
  items/archive/<id>.json    acked/resolved items (audit survives)
  incoming/<id>.json         cross-process drop-box (drained on the timer)
  posture.json               { mode: "auto" | "available" | "busy" }
```

One-file-per-item (not a shared jsonl) because senders are concurrent and
out-of-process: a temp-write+rename per file is atomic without a lock. A torn
jsonl append would corrupt the whole queue; a torn item file is one skippable
item. Survives `/reload`, `/new`, `/fork`, and crashes because it is on disk,
not in memory.

---

## Postures

Two channel states, **visible at all times in pi's footer** (`◉ available` /
`◌ busy`). Posture dictates delivery policy.

- **available** — Kevin is reachable; items deliver on their base tier.
- **busy** — Kevin (or the agent) is heads-down; every priority is demoted one
  tier **except P0**.

**Transitions (auto mode):**
- any user message activity → busy (`input` hook)
- agent working → busy (`agent_start`)
- back to available only after the agent has been settled **and** there has
  been no user interaction for `settleToAvailableMs` (default 2 min).

**Manual override:** `/posture busy|available|auto`. `auto` returns to
inference. Manual state persists across restarts (`posture.json`); activity
timers reseed on session start (a fresh session starts *busy* until it settles —
safer than dumping the queue into a just-resumed agent).

### Typing detection — the answer

**Can a pi extension detect typing-started (keystrokes before submit)?**
**Partially, and only invasively — so we did NOT use it.**

- There is **no passive editor/keystroke event**. `input` fires only on
  *submit*, not per keypress. `message_update` is assistant-stream only.
- The **only** keystroke-level seam is `ctx.ui.setEditorComponent(factory)`
  with a `CustomEditor` subclass whose `handleInput(data)` sees every keypress
  (see pi `examples/extensions/border-status-editor.ts`,
  `modal-editor.ts`). But an extension can install **one** editor component —
  taking it over here would collide with any other extension that wants the
  editor, and couples posture to owning the input widget.

**Decision:** fall back to **message-receipt** (`input` on submit) as the busy
trigger, per the feasibility doc's fallback. This is honest: "Kevin sent
something → busy" is a correct, if slightly coarser, signal, and it costs no
UI ownership.

**To upgrade to true typing detection in this session:** implement a
`CustomEditor` subclass that, in `handleInput`, calls back into the inbox to set
`lastActivity = Date.now()` on the first printable keystroke (debounced), then
`ctx.ui.setEditorComponent((tui, theme, kb) => new TypingAwareEditor(...))` in
`session_start`. The subscriber extension's STT pipeline already knows when
Kevin is mid-speech and could feed the same `lastActivity` via
`pi.events.emit("inbox:activity")` — a hook worth adding if voice posture
matters. Neither is wired now.

---

## Delivery tiers

Ordered most-active → most-passive. A tier is *how* an item reaches the
conversation, never *whether* it is tracked.

| Tier | Behavior |
|------|----------|
| **steer** | deliver ASAP via `deliverAs:"steer"` + `triggerTurn` (next tool boundary; pi's serial loop makes truly-mid-tool impossible — the known ceiling). **Auto-acks.** |
| **nudge** | inject a one-line summary prefix into the NEXT turn: `📥 inbox: <summary> — /ack <id> for details`. Full body only on explicit `/ack`. Rides `before_agent_start` (appended, never triggers a turn). |
| **wait** | deliver + auto-ack only after the agent has been settled ≥ `waitSettleMs` (default 5 min) **and** posture allows. In busy posture: hold entirely. |
| **linger** | most passive: never delivered individually. A single digest line for ALL lingering items after sustained idle (default 5 min) or on `/peek`. |

### Default mapping (per-priority × per-posture)

| Priority | available | busy (demote 1, P0 exempt) |
|----------|-----------|-----------------------------|
| **P0** | steer | steer (protected) |
| **P1** | nudge | wait |
| **P2** | wait | linger |
| **P3** | linger | linger |

The mapping lives in a plain config table (`DEFAULT_CONFIG` in `policy.ts`),
editable later. It is a pure function of `(item, posture, clock, config)`, so
the whole matrix is headlessly testable (`inbox.test.ts`).

### Escalation

If `suggested_deadline` passes, the item is **promoted one tier, once**
(advisory escalation, latched via `escalated`). Applied *before* busy-posture
demotion, so an escalated P2 in busy posture nets back to its available tier.

---

## Commands

| Command | Effect |
|---------|--------|
| `/peek` | Queue snapshot (id, priority, type, age, resolved tier, summary) WITHOUT delivering or acking. The courtesy view. |
| `/ack [id\|all]` | Acknowledge nudged item(s); inject full body (as `followUp` — a read, not an interrupt) and resolve. Bare `/ack` = all pending. |
| `/remind <text> [--in <dur>\|--at <time>]` | Enqueue a self-reminder (type `notify`, priority 2). `--in 30m`, `--in 2h`, `--at 15:00`, `--at 2026-08-20T15:00`. Bare number = minutes. |
| `/posture [busy\|available\|auto]` | Show or set posture; `auto` returns to inference. |
| `/snooze <id> <duration>` | Suppress an item entirely until the duration elapses. |

---

## Enqueue paths

### (a) In-process — the shared event bus

Same-process senders (subagent poller, subscriber server) fire-and-forget:

```ts
pi.events.emit("inbox:add", {
  priority: 1, type: "notify",
  summary: "build failed", body: "…", source: "subagent",
});
```

No import cycle, no coupling. The inbox subscribes to `inbox:add` and promotes
the envelope into a queue item. (The factory also *returns* `{ enqueue }` for
rare SDK embeds that hold the `ExtensionAPI` directly.)

### (b) Out-of-process — the drop-box (marker-file pattern)

Cron, background services, herdr, anything not in pi's process:

```sh
familiar.sh inbox-enqueue --summary "Emerson account followup" \
  --priority 1 --type notify [--body TEXT | --body-file F] \
  [--source cron] [--deadline 1755690000000]
```

writes an atomic envelope to `state/inbox/incoming/<id>.json`. The extension
drains that directory on its timer (default every 15s, plus on every
`agent_settled`), claims each file by rename, and promotes it. Mirrors the
existing herdr reload-marker pattern (`FAMILIAR_RELOAD_REQUEST_PATH`): no daemon,
no socket, just a file the resident process picks up.

### Envelope schema (the stable contract)

```jsonc
{
  "summary": "required — short",       // the only required field
  "priority": 2,                       // default 2
  "type": "notify",                    // default "notify"
  "body": "…",                         // default = summary
  "source": "cli",                     // default per channel
  "suggested_deadline": 1755690000000, // optional (ms epoch)
  "id": "…"                            // optional — supply for idempotent re-enqueue
}
```

Future senders (subagent settlements, subscriber ingress, cron) adopt this
envelope unchanged. **The subagent extension is the intended first client** —
its settlements currently `deliverAs:"steer"` + `triggerTurn` directly (labor
and reply share a lane; labor wins). Routing them through `inbox:add` with
severity from status (failed→P0/P1, ok→P2) is the redirect described in the
feasibility doc's plumbing table. **Not rewired in this pass** — noted as the
first adopter.

---

## Widget

A widget appears **IFF the inbox is non-empty**: `📥 <count> (P<top>)`, giving
both Kevin and the agent ambient visibility.

**Placement caveat:** pi's extension UI has no *top-right widget* slot.
`ctx.ui.setWidget` supports only `aboveEditor` (default) and `belowEditor`
(pi `docs/tui.md`). The only top-right surfaces are the editor's own border
(via a `CustomEditor`, single-owner) or a full `setFooter` replacement (clobbers
the built-in footer). So the widget renders **directly above the editor** — the
closest ambient rail available without seizing the editor or footer. Posture,
separately, rides the footer via `ctx.ui.setStatus("inbox-posture", …)`, which
*is* the intended multi-extension footer-status mechanism.

---

## Files

```
extensions/inbox/
  policy.ts        pure decision core (tiers, posture, escalation) — no I/O
  store.ts         durable queue + atomic writes + drop-box drain — I/O only
  index.ts         extension: hooks, timer, commands, delivery, surfaces
  inbox.test.ts    headless tests (bun) for policy + store + parseWhen
  PROTOCOL.md      this file
```

Test: `nix develop .#stt -c bun test extensions/inbox/inbox.test.ts`
(bun lives in the `.#stt` dev shell; there is no `node` in `.#pi`).
