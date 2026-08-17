# Waker Extension — Design Spec (draft, sussed from pi 0.84.1)

A "waking room": a pi session that sleeps when idle, wakes on external
stimulus, receives pre-turn context injection, and rolls epochs with
handoffs. Cranium-room semantics, one process, no daemon beside pi.

Division of labor (three extensions, one bus):
- **identity** — owns system prompt assembly (static-ish).
- **subscriber** — owns transport (HTTP ingress/egress, voice).
- **waker** — owns lifecycle: wake, sleep, scheduled stimuli, epochs.
Inter-extension comms via `pi.events` (built-in bus, verified in
examples/extensions/event-bus.ts).

## Wake primitives (all verified in docs/extensions.md)

- `pi.sendMessage({customType, content, display}, {triggerTurn: true})`
  — THE wake call. If agent idle, triggers an LLM response. Message
  participates in LLM context, carries a customType tag.
- `deliverAs` controls arrival while busy: `"steer"` (after current
  tool batch, before next LLM call), `"followUp"` (after fully done),
  `"nextTurn"` (passive; waits for next real prompt — this is the
  "leave a note on the desk" mode, no wake).
- `pi.sendUserMessage(...)` — as-if-typed, always triggers a turn.
  Subscriber already uses this for voice/text ingress.
- Sleep edge: `agent_settled` — NOT `agent_end` (which fires before
  auto-retry/auto-compact/queued continuations). `ctx.isIdle()` /
  `ctx.hasPendingMessages()` for polling.

## Stimulus sources

1. **External calls** (other rooms, cron, fort): arrive via subscriber's
   HTTP port → subscriber emits `familiar:ingress` on `pi.events` →
   waker decides disposition (wake now / steer / nextTurn note) based
   on idle state + payload urgency. Keeps transport and policy separate.
2. **Timers**: waker-owned alarm registry (plain setTimeout; pi
   extensions are long-lived module instances). On fire: idle → wake
   with triggerTurn; busy → queue as nextTurn.
3. **Filesystem**: file-trigger pattern (fs.watch → sendMessage) as the
   zero-dependency cross-process wake; useful before subscriber is done.

## Pre-turn injection (the "it's been 2 hours" / cross-room block)

Two hooks, different jobs:
- `before_agent_start` — chained systemPrompt mutation. Identity owns
  this; waker should NOT fight it.
- `context` event — fires per LLM call, can mutate the message list.
  This is where transient orientation goes: time-gap notices, weather,
  cross-room diffs. Injected as messages, not prompt — survives
  identity's prompt ownership, skips persistence.

## Epochs (the interesting one)

- Saturation check: `ctx.getContextUsage()` (tokens + estimate) at
  `agent_settled`.
- **Hard constraint discovered:** session control (`newSession`, `fork`,
  `switchSession`, `waitForIdle`) lives on `ExtensionCommandContext` —
  available ONLY in command handlers, by design (deadlock guard).
  An `agent_settled` handler cannot roll the epoch directly.
  So: register `/epoch` as an extension command; the settled-handler
  path requests it rather than performing it.
- Rollover flow inside the command:
  1. `await ctx.waitForIdle()`
  2. Handoff generation — either (a) send a final in-session turn asking
     the model to write its own handoff (cranium-style, richer), or
     (b) synthesize mechanically from session entries (cheaper, worse).
  3. `ctx.newSession({ parentSession, setup: sm => append handoff as
     seed message, withSession: ctx2 => ctx2.sendUserMessage(kickoff) })`
  4. Footguns (documented, real): withSession runs after old runtime
     teardown; use ONLY the replacement ctx; capture nothing but plain
     strings/ids across the boundary.
- Lighter v1: `ctx.compact({ customInstructions: <handoff-flavored> })`
  — in-place, no session split, no command-context dance. Ship this
  first; true epochs when the handoff quality difference matters.

## State

- `pi.appendEntry(customType, data)` — persisted, NOT in LLM context.
  Alarms, correlation ids, epoch counters live here; rebuild on
  `session_start` by scanning `ctx.sessionManager.getEntries()`.
- `pi.setSessionName()` — room naming for the session selector.

## Headless note

RPC mode (`pi --mode rpc`) exists and extension commands work through
its prompt path — a waker-managed room can later run headless under
systemd with the same extension stack. Guard all UI calls with
`ctx.hasUI` now so this stays free.

## Open questions

- Can an extension invoke a registered command programmatically (does
  `pi.sendUserMessage("/epoch")` route through command dispatch, as the
  RPC prompt path does)? Determines whether epoch-on-saturation can be
  fully automatic or needs the external trigger to say "/epoch".
- Handoff authoring: model-written (extra turn, costs tokens at exactly
  the moment context is scarce) vs entry-synthesis vs compact-with-
  instructions. Probably: compact early, model-written at the ceiling.
- Does `context` event injection persist to the session file or stay
  per-call? (Determines whether time-gap notices pollute history.)
