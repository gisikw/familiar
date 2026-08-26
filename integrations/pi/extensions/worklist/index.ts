import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { errorLog } from "../lib/debug.ts";
import {
  DEFAULT_CONFIG,
  decideAction,
  resolveAttention,
  applyVoiceHold,
  makeOverride,
  overrideExpired,
  parseWhen,
  parseDurationMs,
  isPending,
  resolveTier,
  shouldEscalate,
  type Attention,
  type AttentionMode,
  type AttentionOverride,
  type Priority,
  type QueueItem,
} from "./policy.ts";
import {
  archiveItem,
  drainIncoming,
  ensureDirs,
  enqueueEnvelopeIdempotent,
  getArchivedItem,
  getItem,
  worklistPaths,
  listItems,
  putItem,
  readAttention,
  writeAttention,
  type EnqueueEnvelope,
} from "./store.ts";
import {
  registry,
  WORKLIST_SINK,
  WORKLIST_SINK_VERSION,
  type DurableSink,
  type DurableEnqueueEnvelope,
  type DurableAcceptance,
} from "../lib/capabilities.ts";

/* ============================================================================
 * WORKLIST — durable, attention-policed queue of out-of-band items for pi
 * ============================================================================
 *
 * The worklist is a durable, referable collection of OUT-OF-BAND work: subagent
 * settlements, cron wakeups, monitor alerts, self-authored reminders/prompts,
 * questions, and opportunities. It is NOT the durable ticket/task system, and
 * NOT email — real user messages and tool results NEVER pass through it (that's
 * architecture, not policy). ATTENTION is the policy that governs WHEN a
 * worklist item may surface into the live conversation.
 *
 * It works by CONVENTION, not interception: pi's injection is push-only (no
 * veto hook), so senders ENQUEUE here instead of calling pi.sendMessage, and
 * this extension owns the delivery policy. See PROTOCOL.md.
 *
 * Responsibilities:
 *   - own the durable queue (store.ts) and drain cross-process enqueues
 *   - track ATTENTION (open/available/focused/protected) + show it in the
 *     footer AT ALL TIMES, with a live countdown while a manual override holds
 *   - run a scheduler tick that delivers items by tier × attention (policy.ts)
 *   - surface the queue: widget + /peek + /ack
 *   - register a versioned durable-enqueue SINK on the neutral capability
 *     registry so subagent settlements can route through attention without
 *     either extension importing the other
 *
 * No blocking work in hooks; the only timer is a session-scoped setInterval
 * started in session_start and cleared in session_shutdown.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.dirname(HERE);
const REPO = path.dirname(EXT_DIR);
// New canonical path; FAMILIAR_WORKLIST_DIR wins, then legacy FAMILIAR_INBOX_DIR
// (bounded compat), else state/worklist.
const WORKLIST_ROOT =
  process.env.FAMILIAR_WORKLIST_DIR ||
  process.env.FAMILIAR_INBOX_DIR ||
  path.join(REPO, "state", "worklist");
const LEGACY_ROOT = path.join(REPO, "state", "inbox");

const TICK_MS = 15_000;
const VOICE_HOLD_MS = 30_000;
const CFG = DEFAULT_CONFIG;

const PRI_LABEL = (p: Priority) => `P${p}`;

function ageStr(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Short remaining-time string for an expiry countdown, e.g. "24m", "1h3m". */
function remainStr(msLeft: number): string {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
}

/** Parse "30m" / "2h" / "--at 15:00" style durations to a deadline (ms epoch).
 *  Re-exported from policy.ts (pure) so index stays free of duration logic. */
export { parseWhen, parseDurationMs } from "./policy.ts";

export default function (pi: ExtensionAPI) {
  const P = worklistPaths(WORKLIST_ROOT);

  // In-memory attention inputs. The persisted override survives restart;
  // activity is re-seeded on session_start (a fresh session starts "focused"
  // until it settles).
  let mode: AttentionMode = "auto";
  let override: AttentionOverride | null = null;
  let lastActivity = Date.now();
  let agentBusy = false;
  let idleSince = Date.now();
  let voiceHoldUntil = 0;
  let ctxRef: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sinkDisposer: (() => void) | undefined;
  // Ids withdrawn via the durable sink. A tombstone refuses a later/in-flight
  // enqueue for the same id so an await-claimed settlement cannot resurface.
  const tombstones = new Set<string>();

  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      errorLog("worklist", { handlerError: String(err) });
    }
  };

  /** Lazily expire an elapsed override, persisting the clear so the footer and
   *  disk stay honest. Correctness does not depend on this firing — resolve is
   *  lazy — but it keeps the persisted file clean. */
  const expireIfElapsed = (now = Date.now()): boolean => {
    if (override && overrideExpired(override, now)) {
      override = null;
      mode = "auto";
      writeAttention(P, { mode, override });
      return true;
    }
    return false;
  };

  const currentAttention = (now = Date.now()): Attention =>
    applyVoiceHold(resolveAttention({ override, lastActivity, agentBusy, now }, CFG), voiceHoldUntil, now);

  const idleForMs = (): number => (agentBusy ? 0 : Date.now() - idleSince);

  /* --- ambient surfaces: footer attention + worklist widget -------------- */

  const GLYPH: Record<Attention, string> = {
    open: "○",
    available: "◐",
    focused: "◑",
    protected: "●",
  };

  const renderAttention = () => {
    if (!ctxRef?.hasUI) return;
    const now = Date.now();
    const a = currentAttention(now);
    let text = `${GLYPH[a]} ${a}`;
    if (override && now < override.expiresAt) {
      text += ` ${remainStr(override.expiresAt - now)}`;
    }
    ctxRef.ui.setStatus("attention", text);
  };

  const renderWidget = () => {
    if (!ctxRef?.hasUI) return;
    const pending = listItems(P).filter(isPending);
    if (pending.length === 0) {
      ctxRef.ui.setWidget("worklist", undefined);
      return;
    }
    const now = Date.now();
    const top = pending.reduce<Priority>((m, it) => (it.priority < m ? it.priority : m), 3 as Priority);
    const a = currentAttention(now);
    // During a protected override, make the suppression legible, not spooky:
    // show the held count + the countdown.
    let line = `📋 ${pending.length} (${PRI_LABEL(top)})`;
    if (a === "protected" && override) {
      line = `📋 ${pending.length} held (${PRI_LABEL(top)}) · protected ${remainStr(override.expiresAt - now)}`;
    }
    ctxRef.ui.setWidget("worklist", [line]);
  };

  const refreshSurfaces = () => {
    renderAttention();
    renderWidget();
  };

  /* --- delivery ---------------------------------------------------------- */

  const deliverBody = (item: QueueItem, opts: { steer: boolean; autoAck: boolean }) => {
    const lines = [
      `<worklist-item id="${item.id}" type="${item.type}" priority="${PRI_LABEL(item.priority)}" source="${item.source}">`,
      item.body || item.summary,
      `</worklist-item>`,
    ];
    pi.sendMessage(
      { customType: "worklist-item", content: lines.join("\n"), display: true },
      opts.steer
        ? { deliverAs: "steer", triggerTurn: true }
        : { deliverAs: "followUp" },
    );
    item.delivered = true;
    if (opts.autoAck) {
      item.acked = true;
      putItem(P, item);
      // Resolved items leave the live queue for the archive (audit survives,
      // but /peek and the widget stay clean and bounded).
      archiveItem(P, item.id);
    } else {
      putItem(P, item);
    }
  };

  /** Surface a one-line nudge without waking the model or delivering its body.
   *  Normally nudges ride before_agent_start. Under `open`, however, there may
   *  be no next turn; append one visible nudge so long-idle promotion cannot
   *  turn into permanent silence. surfacedCount makes the idle path one-shot. */
  const deliverIdleNudge = (item: QueueItem) => {
    const line = `📋 worklist: ${item.summary} — /ack ${item.id} for details`;
    pi.sendMessage({
      customType: "worklist-nudge",
      content: `<worklist-nudge id="${item.id}" priority="${PRI_LABEL(item.priority)}">\n${line}\n</worklist-nudge>`,
      display: true,
    });
    item.surfacedCount = (item.surfacedCount ?? 0) + 1;
    putItem(P, item);
  };

  // The linger digest: a single line for ALL lingering items, never one-per.
  const deliverDigest = (items: QueueItem[]) => {
    const lines = items.map(
      (it) => `  • ${PRI_LABEL(it.priority)} ${it.summary} — /ack ${it.id}`,
    );
    pi.sendMessage(
      {
        customType: "worklist-digest",
        content: `<worklist-digest count="${items.length}">\n${lines.join("\n")}\n</worklist-digest>`,
        display: true,
      },
      { deliverAs: "followUp" },
    );
    for (const it of items) {
      it.digested = true;
      putItem(P, it);
    }
  };

  /**
   * Scheduler tick: drain cross-process enqueues, apply deadline escalation,
   * then act on each live item per the pure policy. Nudges are collected and
   * surfaced on the NEXT turn via before_agent_start (not here) so they ride
   * the prefix cache without triggering a turn.
   */
  const tick = () => {
    ensureDirs(P, LEGACY_ROOT);
    const created = drainIncoming(P);
    const now = Date.now();
    const elapsed = expireIfElapsed(now);
    const attention = currentAttention(now);

    let dirtySurfaces = created.length > 0 || elapsed;
    const items = listItems(P).filter(isPending);
    const lingerBatch: QueueItem[] = [];

    for (const item of items) {
      // Advisory escalation: latch once when the deadline passes.
      if (shouldEscalate(item, now)) {
        item.escalated = true;
        putItem(P, item);
        dirtySurfaces = true;
      }

      const action = decideAction(item, { attention, now, idleForMs: idleForMs() }, CFG);
      switch (action) {
        case "deliver-steer":
          deliverBody(item, { steer: true, autoAck: true });
          dirtySurfaces = true;
          break;
        case "deliver-wait":
          // Waiting is a timing policy, not a permanent transport choice. Once
          // quiet has lasted long enough, wake the model with the full body.
          deliverBody(item, { steer: true, autoAck: true });
          dirtySurfaces = true;
          break;
        case "digest":
          lingerBatch.push(item);
          break;
        case "nudge":
          // `open` means solicit during long idle. before_agent_start cannot
          // help when there is no next turn, so visibly surface the summary
          // once without waking the model or auto-acking the body.
          if (attention === "open" && (item.surfacedCount ?? 0) === 0) {
            deliverIdleNudge(item);
            dirtySurfaces = true;
          }
          break;
        case "hold":
          break;
      }
    }

    if (lingerBatch.length > 0) {
      deliverDigest(lingerBatch);
      dirtySurfaces = true;
    }
    if (dirtySurfaces) refreshSurfaces();
    else renderAttention(); // keep the countdown ticking even when idle
  };

  const tickGuarded = () => guard(tick);

  /* --- exported in-process enqueue API ----------------------------------- */
  const enqueue = (env: EnqueueEnvelope): QueueItem => {
    ensureDirs(P, LEGACY_ROOT);
    const { item, created } = enqueueEnvelopeIdempotent(P, env);
    if (created) refreshSurfaces();
    return item;
  };

  /* --- durable sink capability (the subagent seam) ----------------------- */
  // Register a versioned async sink on the NEUTRAL registry. Subagent resolves
  // it at courtesy-delivery time and awaits durable acceptance; if absent,
  // rejected, or errored, subagent falls back to its direct relay. Neither
  // extension imports the other. The sink dedupes on stable id and supports
  // withdraw() so a settlement claimed by subagent_await can be pulled before
  // it ever surfaces (the exactly-once invariant — see PROTOCOL.md).
  const sink: DurableSink = {
    async enqueue(env: DurableEnqueueEnvelope): Promise<DurableAcceptance> {
      ensureDirs(P, LEGACY_ROOT);
      const id = env.id;
      // Tombstone guard: a concurrent withdraw() (e.g. subagent_await claimed
      // this settlement while THIS enqueue was in-flight) marks the id dead.
      // Refuse to queue it — delivery is owned elsewhere. `superseded` tells
      // the caller NOT to fall back to a direct relay.
      if (id && tombstones.has(id)) {
        return { accepted: false, superseded: true, id, reason: "withdrawn before enqueue" };
      }
      // Idempotent on id: if already known (live/archived), report accepted
      // without duplicating — the caller's earlier enqueue owns it.
      const { item, created } = enqueueEnvelopeIdempotent(P, {
        id,
        priority: env.priority,
        type: (env.type as QueueItem["type"]) ?? "notify",
        summary: env.summary,
        body: env.body,
        source: env.source ?? "subagent",
        ...(typeof env.suggested_deadline === "number"
          ? { suggested_deadline: env.suggested_deadline }
          : {}),
      });
      if (created) refreshSurfaces();
      return { accepted: true, id: item.id };
    },
    async withdraw(id: string): Promise<boolean> {
      // Set the tombstone FIRST so an enqueue that is still in-flight for this
      // id will be refused when it resolves. This is what makes the
      // await-claims-a-queued-settlement race safe in both orderings.
      tombstones.add(id);
      const item = getItem(P, id);
      if (!item) {
        const archived = getArchivedItem(P, id);
        if (!archived) return true; // tombstone catches a genuinely late enqueue
        // Terminal history decides ownership after restart: delivered/acked was
        // already surfaced; withdrawn was explicitly claimed by await.
        return archived.withdrawn === true ? true : !(archived.delivered || archived.acked);
      }
      if (item.delivered || item.acked) return false; // too late — already surfaced
      item.withdrawn = true;
      putItem(P, item);
      archiveItem(P, id);
      refreshSurfaces();
      return true;
    },
  };

  // Publish during factory initialization, not session_start, so extension
  // loader order cannot make subagent startup reconciliation bypass attention.
  // Only advertise after durable storage has been verified.
  try {
    ensureDirs(P, LEGACY_ROOT);
    sinkDisposer = registry.register<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION, sink);
  } catch (err) {
    errorLog("worklist", { storageDisabled: String(err) });
  }

  // Publish on the shared bus too, so fire-and-forget senders (cron, subscriber)
  // can enqueue without an import cycle. NOTE: this is fire-and-forget only —
  // pi.events.emit returns void and gives no acceptance guarantee, so the
  // subagent seam uses the capability sink above, NOT this event.
  pi.events.on("worklist:add", (env: unknown) => guard(() => enqueue(env as EnqueueEnvelope)));
  // Bounded compat: keep the old channel for one release so mid-flight senders
  // (familiar.sh, cron) don't silently drop items.
  pi.events.on("inbox:add", (env: unknown) => guard(() => enqueue(env as EnqueueEnvelope)));

  // Process-local, fire-and-forget focus signal from subscriber. Active voice
  // gets a short lease; idle releases immediately. A lost terminal event can
  // therefore suppress ordinary work for at most VOICE_HOLD_MS.
  pi.events.on("voice:status", (event: unknown) => guard(() => {
    const phase = (event as { phase?: unknown })?.phase;
    if (phase === "capturing" || phase === "transcribing") {
      voiceHoldUntil = Date.now() + VOICE_HOLD_MS;
    } else if (phase === "idle") {
      voiceHoldUntil = 0;
    } else return;
    refreshSurfaces();
  }));

  /* --- attention control (one code path for command, tool, restart) ------ */

  const setOverride = (
    level: AttentionOverride["level"],
    durationMs: number,
    now = Date.now(),
  ): AttentionOverride | null => {
    const ov = makeOverride(level, durationMs, now, CFG);
    if (!ov) return null;
    override = ov;
    mode = level;
    writeAttention(P, { mode, override });
    refreshSurfaces();
    return ov;
  };

  const clearOverride = () => {
    override = null;
    mode = "auto";
    writeAttention(P, { mode, override });
    refreshSurfaces();
  };

  /* --- commands ---------------------------------------------------------- */

  pi.registerCommand("peek", {
    description: "Worklist: show the queue snapshot (does not deliver or ack)",
    handler: async (_args, ctx) => {
      const items = listItems(P).filter(isPending);
      if (items.length === 0) {
        ctx.ui.notify("📋 worklist empty", "info");
        return;
      }
      const now = Date.now();
      const attention = currentAttention(now);
      const rows = items
        .sort((a, b) => a.priority - b.priority || a.ts - b.ts)
        .map((it) => {
          const tier = resolveTier(it, attention, CFG);
          const dl = it.suggested_deadline
            ? ` due:${new Date(it.suggested_deadline).toLocaleTimeString()}`
            : "";
          return `${PRI_LABEL(it.priority)} [${it.type}] ${it.id}  ${ageStr(it.ts)}  ${tier}${dl}\n    ${it.summary}`;
        });
      ctx.ui.notify(`📋 worklist (${items.length}, attention: ${attention})\n${rows.join("\n")}`, "info");
    },
  });

  pi.registerCommand("ack", {
    description: "Worklist: acknowledge nudged item(s) and inject full body. /ack [id|all]",
    getArgumentCompletions: (prefix) => {
      const items = listItems(P).filter(isPending);
      const opts = [{ value: "all", label: "all" }, ...items.map((it) => ({ value: it.id, label: `${it.id} — ${it.summary}` }))];
      const f = opts.filter((o) => o.value.startsWith(prefix));
      return f.length ? f : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim();
      const pending = listItems(P).filter(isPending);
      const targets =
        arg === "" || arg === "all"
          ? pending
          : pending.filter((it) => it.id === arg);
      if (targets.length === 0) {
        ctx.ui.notify(arg ? `no pending item "${arg}"` : "📋 nothing to ack", "warning");
        return;
      }
      for (const it of targets) {
        deliverBody(it, { steer: false, autoAck: true });
      }
      refreshSurfaces();
      ctx.ui.notify(`📋 acked ${targets.length} item(s)`, "info");
    },
  });

  pi.registerCommand("remind", {
    description: "Worklist: enqueue a self-reminder. /remind <text> [--at <time>|--in <duration>]",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) {
        ctx.ui.notify("usage: /remind <text> [--in 30m | --at 15:00]", "warning");
        return;
      }
      let text = raw;
      let deadline: number | undefined;
      const m = raw.match(/\s--(in|at)\s+(.+)$/);
      if (m) {
        text = raw.slice(0, m.index).trim();
        deadline = parseWhen(m[2], Date.now());
      }
      const item = enqueue({
        priority: 2,
        type: "notify",
        summary: text,
        body: text,
        source: "remind",
        ...(deadline ? { suggested_deadline: deadline } : {}),
      });
      ctx.ui.notify(
        `📋 reminder queued (${item.id})${deadline ? ` due ${new Date(deadline).toLocaleString()}` : ""}`,
        "info",
      );
    },
  });

  const LEVEL_GLOSS: Record<string, string> = {
    auto: "auto — infer from conversation activity (open/available/focused)",
    available: "available — accept important items as they arrive; hold trivia for a lull",
    focused: "focused — active conversation; suppress ordinary interruptions",
    protected: "protected — total do-not-disturb, time-bounded, queue stays durable",
  };

  const DURATION_HINTS = ["15m", "30m", "1h", "2h"];

  pi.registerCommand("attention", {
    description: "Worklist: show/set attention. /attention [auto|available|focused|protected] [duration]",
    getArgumentCompletions: (prefix) => {
      const parts = prefix.split(/\s+/);
      if (parts.length <= 1) {
        const opts = ["auto", "available", "focused", "protected"].map((v) => ({
          value: v,
          label: v,
          description: LEVEL_GLOSS[v],
        }));
        const f = opts.filter((o) => o.value.startsWith(parts[0] ?? ""));
        return f.length ? f : null;
      }
      // second token: duration hints (not for auto)
      if (parts[0] === "auto") return null;
      const durPrefix = parts[1] ?? "";
      const now = Date.now();
      const opts = DURATION_HINTS.map((d) => {
        const when = parseWhen(d, now);
        return {
          value: `${parts[0]} ${d}`,
          label: d,
          description: when ? `${d} — resume at ${new Date(when).toLocaleTimeString()}` : d,
        };
      });
      const f = opts.filter((o) => o.label.startsWith(durPrefix));
      return f.length ? f : null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        const now = Date.now();
        const a = currentAttention(now);
        const tail = override && now < override.expiresAt
          ? ` (manual ${override.level}, ${remainStr(override.expiresAt - now)} left)`
          : " (auto)";
        ctx.ui.notify(`attention: ${a}${tail}`, "info");
        return;
      }
      const level = parts[0].toLowerCase();
      if (level === "auto") {
        clearOverride();
        ctx.ui.notify(`attention → auto (now: ${currentAttention()})`, "info");
        return;
      }
      if (level !== "available" && level !== "focused" && level !== "protected") {
        ctx.ui.notify("usage: /attention [auto|available|focused|protected] [duration e.g. 30m]", "warning");
        return;
      }
      const durSpec = parts[1];
      if (!durSpec) {
        ctx.ui.notify(`/attention ${level} needs a duration (e.g. /attention ${level} 30m). It is always time-bounded.`, "warning");
        return;
      }
      const durMs = parseDurationMs(durSpec, Date.now());
      if (durMs === undefined) {
        ctx.ui.notify(`bad duration "${durSpec}"`, "warning");
        return;
      }
      const ov = setOverride(level as AttentionOverride["level"], durMs);
      if (!ov) {
        ctx.ui.notify(`invalid duration "${durSpec}"`, "warning");
        return;
      }
      ctx.ui.notify(
        `attention → ${level} until ${new Date(ov.expiresAt).toLocaleTimeString()} (${remainStr(ov.expiresAt - Date.now())})`,
        "info",
      );
    },
  });

  pi.registerCommand("protect", {
    description: "Worklist: hold ALL items (even urgent) for a duration, then auto-resume. /protect <duration>",
    getArgumentCompletions: (prefix) => {
      const now = Date.now();
      const opts = DURATION_HINTS.map((d) => {
        const when = parseWhen(d, now);
        return {
          value: d,
          label: d,
          description: when
            ? `protected until ${new Date(when).toLocaleTimeString()} — hold everything, incl. P0`
            : d,
        };
      });
      const f = opts.filter((o) => o.label.startsWith(prefix));
      return f.length ? f : null;
    },
    handler: async (args, ctx) => {
      const spec = args.trim();
      if (!spec) {
        ctx.ui.notify("usage: /protect <duration e.g. 30m> — hold ALL items until it elapses", "warning");
        return;
      }
      const durMs = parseDurationMs(spec, Date.now());
      if (durMs === undefined) {
        ctx.ui.notify(`bad duration "${spec}"`, "warning");
        return;
      }
      const ov = setOverride("protected", durMs);
      if (!ov) {
        ctx.ui.notify(`invalid duration "${spec}"`, "warning");
        return;
      }
      ctx.ui.notify(
        `● protected until ${new Date(ov.expiresAt).toLocaleTimeString()} (${remainStr(ov.expiresAt - Date.now())}) — holding everything, incl. P0`,
        "info",
      );
    },
  });

  pi.registerCommand("snooze", {
    description: "Worklist: suppress an item for a duration. /snooze <id> <duration>",
    getArgumentCompletions: (prefix) => {
      const items = listItems(P).filter(isPending);
      const f = items.map((it) => ({ value: it.id, label: `${it.id} — ${it.summary}` })).filter((o) => o.value.startsWith(prefix));
      return f.length ? f : null;
    },
    handler: async (args, ctx) => {
      const [id, dur] = args.trim().split(/\s+/);
      if (!id || !dur) {
        ctx.ui.notify("usage: /snooze <id> <duration e.g. 30m>", "warning");
        return;
      }
      const item = getItem(P, id);
      if (!item) {
        ctx.ui.notify(`no item "${id}"`, "warning");
        return;
      }
      const until = parseWhen(dur, Date.now());
      if (!until) {
        ctx.ui.notify(`bad duration "${dur}"`, "warning");
        return;
      }
      item.snoozedUntil = until;
      putItem(P, item);
      refreshSurfaces();
      ctx.ui.notify(`📋 snoozed ${id} until ${new Date(until).toLocaleTimeString()}`, "info");
    },
  });

  /* --- model-callable tool ----------------------------------------------- */
  // Exo can protect the conversation herself ("Kevin's driving, go protected").
  // Every non-auto level REQUIRES a duration and is clamped — the tool can
  // never set an unbounded state.
  pi.registerTool({
    name: "set_attention",
    label: "Set Attention",
    description:
      "Time-bound how interruptible the live conversation is to background worklist items. " +
      "level 'protected' holds EVERYTHING (even urgent P0) until it expires; 'focused' suppresses ordinary " +
      "interruptions; 'available' accepts important items; 'auto' returns to activity-inferred attention. " +
      "Any non-auto level REQUIRES duration_minutes and is clamped to a ceiling — it can never be unbounded. " +
      "On expiry attention returns directly to auto inference (no decay). Returns the resolved expires_at so " +
      "you can tell Kevin exactly when it lifts.",
    promptSnippet: "Time-bound how interruptible the conversation is (protect/focus/available)",
    parameters: Type.Object({
      level: Type.Union([
        Type.Literal("auto"),
        Type.Literal("available"),
        Type.Literal("focused"),
        Type.Literal("protected"),
      ], { description: "auto returns to inference; the others are timed overrides" }),
      duration_minutes: Type.Optional(Type.Number({ description: "Required for any non-auto level; clamped to the ceiling (8h)." })),
    }),
    async execute(_id, params: { level: string; duration_minutes?: number }) {
      const level = params.level;
      // One widened details shape across all branches so the tool's TDetails
      // unifies (pinned pi 0.84.1 requires a non-optional `details`).
      const result = (details: Record<string, unknown>, isError = false) => ({
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details,
        ...(isError ? { isError: true } : {}),
      });
      if (level === "auto") {
        clearOverride();
        return result({ ok: true, level: currentAttention(), mode: "auto" });
      }
      if (level !== "available" && level !== "focused" && level !== "protected") {
        return result({ ok: false, error: `unknown level "${level}"` }, true);
      }
      const mins = params.duration_minutes;
      if (typeof mins !== "number" || !(mins > 0)) {
        return result({ ok: false, error: "duration_minutes is required and must be > 0 for a non-auto level" }, true);
      }
      const ov = setOverride(level as AttentionOverride["level"], mins * 60_000);
      if (!ov) {
        return result({ ok: false, error: "invalid duration" }, true);
      }
      return result({ ok: true, level, expires_at: new Date(ov.expiresAt).toISOString(), minutes: Math.round((ov.expiresAt - Date.now()) / 60000) });
    },
  });

  /* --- nudge prefix injection (rides the next turn, no prefix-cache churn) */
  pi.on("before_agent_start", async () => {
    const now = Date.now();
    expireIfElapsed(now);
    const attention = currentAttention(now);
    const nudges = listItems(P)
      .filter(isPending)
      .filter((it) => decideAction(it, { attention, now, idleForMs: idleForMs() }, CFG) === "nudge");
    if (nudges.length === 0) return;

    for (const it of nudges) {
      it.surfacedCount = (it.surfacedCount ?? 0) + 1;
      putItem(P, it);
    }
    const lines = nudges.map((it) => `📋 worklist: ${it.summary} — /ack ${it.id} for details`);
    return {
      message: {
        customType: "worklist-nudge",
        content: `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`,
        display: false,
      },
    };
  });

  /* --- attention signal wiring ------------------------------------------- */

  pi.on("input", async () => {
    lastActivity = Date.now();
    guard(refreshSurfaces);
  });

  pi.on("agent_start", async () => {
    agentBusy = true;
    lastActivity = Date.now();
    guard(refreshSurfaces);
  });

  pi.on("agent_settled", async () => {
    agentBusy = false;
    idleSince = Date.now();
    guard(refreshSurfaces);
    // A settle is a natural breakpoint — run a tick so wait/linger items that
    // just became eligible don't wait a full timer period.
    tickGuarded();
  });

  /* --- lifecycle --------------------------------------------------------- */

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    // One degradation boundary around ALL of startup: an unwritable state tree
    // (plus, say, an expired override that expireIfElapsed tries to persist)
    // must cleanly disable worklist, never throw out of session_start and brick
    // Familiar. Everything that touches disk or UI lives inside the guard.
    guard(() => {
      ensureDirs(P, LEGACY_ROOT);
      const st = readAttention(P);
      mode = st.mode;
      override = st.override;
      // Discard an already-expired override on load (wall-clock, not
      // session-relative): a /protect set before a crash still expires on time.
      expireIfElapsed(Date.now());
      // A fresh/reloaded session starts "focused" until it settles: safer to
      // hold a low-priority item than to dump the queue into a resumed agent.
      lastActivity = Date.now();
      idleSince = Date.now();
      agentBusy = false;
      voiceHoldUntil = 0;
      refreshSurfaces();

      // Factory initialization normally registered the sink before lifecycle
      // handlers run. Retry here only if storage was unavailable during load,
      // and only AFTER ensureDirs above verified durable storage this session.
      if (!sinkDisposer) {
        sinkDisposer = registry.register<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION, sink);
      }
    });

    if (timer) clearInterval(timer);
    timer = setInterval(tickGuarded, TICK_MS);
    tickGuarded();
  });

  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (sinkDisposer) {
      sinkDisposer();
      sinkDisposer = undefined;
    }
  });

  // Returned for rare SDK embeds that hold the ExtensionAPI directly. Exposing
  // tick also lets the runtime wiring (not just pure policy) be tested headlessly.
  return { enqueue, sink, tick };
}

export type { EnqueueEnvelope } from "./store.ts";
