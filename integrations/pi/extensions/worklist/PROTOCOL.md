# Worklist + Do Not Disturb

The worklist is Familiar's durable queue for **synthetic turns**: subagent
settlements, agent reminders, cron traffic, monitoring notices, and other
out-of-band work. It is not user-message transport.

Real user turns go directly through Pi and are delivered immediately. The
worklist extension neither intercepts nor delays them.

## Do Not Disturb

There is one explicit mode: Do Not Disturb (DND), on or off.

- While DND is on, every worklist item remains durably queued. No body, nudge,
  digest, hidden reminder, acknowledgement, or synthetic turn is injected.
- DND defaults to 30 minutes and always has an absolute wall-clock expiry.
- The user may choose another finite duration. Familiar may request a duration,
  but the operation that persists it caps Familiar at two hours.
- Either the user or Familiar may clear DND immediately.
- User activity does not renew DND. Expiry and clear return directly to normal
  delivery.
- DND and queued items survive reloads, session changes, crashes, and host
  restarts. Already-expired state is cleared when read.

The state is stored atomically at `state/worklist/dnd.json`:

```json
{ "enabled": true, "setBy": "user", "setAt": 1755680000000, "expiresAt": 1755681800000 }
```

Older `attention.json` state is migrated once. A live `focused` or `protected`
override becomes DND with its original expiry and the two-hour Familiar cap;
`auto` and `available` become DND off. The retired level file is not rewritten
or consulted after `dnd.json` exists. Unbounded legacy posture state becomes
off rather than inventing an expiry.

## Normal delivery

Outside DND, sender-assigned priority still controls synthetic delivery:

| Priority | Normal behavior |
|---|---|
| P0 | steer immediately and acknowledge |
| P1 | nudge the next turn; wake after 30 seconds of quiet |
| P2 | wake after 30 seconds of quiet |
| P3 | include in one digest after five minutes of quiet |

A passed advisory deadline promotes an item once. A digest is not an
acknowledgement: the item stays queued, may be read with `ack_worklist`, and is
surfaced explicitly after a bounded grace if still unacknowledged.

After DND clears or expires, the scheduler emits at most one turn-triggering
body per tick, in priority then age order. This avoids an expiry burst. Every
successful body delivery is persisted and archived before another tick can
select it, so repeated ticks do not duplicate it.

## Durable queue

```text
state/worklist/
  items/<id>.json
  items/archive/<id>.json
  incoming/<drop>.json
  acknowledgements/<request>.json
  dnd.json
```

Writes use file sync, atomic rename, and directory sync. Incoming files are
claimed before promotion. A missing caller id is written into the claim before
promotion, and stable ids deduplicate against both live and archived history.
Malformed claims remain for diagnosis rather than being dropped.

The versioned `worklist.durable-sink@1` capability gives subagents durable
acceptance. `subagent_await` withdraws a queued settlement before returning its
result; tombstones close the concurrent withdraw/enqueue race. If the sink is
unavailable, the sender retains its existing direct-delivery fallback.

## Controls

- `/dnd` toggles DND using the 30-minute default.
- `/dnd <duration>` enables it for a user-selected duration.
- `/dnd off` clears it.
- `/peek` inspects queued work without delivery or acknowledgement.
- `/ack [id|all]` reads and resolves queued work for the user.
- `/remind ...` adds a durable synthetic reminder.
- `/snooze <id> <duration>` remains an item-specific queue control.

The established model tool name `set_attention` is retained for call-site
compatibility, but its schema is only `{ enabled, duration_minutes? }` and its
copy describes DND only. For one compatibility migration, execution also maps
legacy `level:"auto"`/`"available"` to clear and old suppression levels to DND on.
The model-facing two-hour cap is enforced in the shared state operation, not
just in schema text.

`ack_worklist({id?})` returns full bodies in its tool result and atomically
archives them; it does not also call `sendMessage`.

## Tests

```sh
nix develop .#stt -c bun test \
  integrations/pi/extensions/worklist/worklist.test.ts \
  integrations/pi/extensions/lib/capabilities.test.ts
```
