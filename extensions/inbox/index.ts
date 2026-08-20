import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { errorLog } from "../lib/debug.ts";
import {
  DEFAULT_CONFIG,
  decideAction,
  inferPosture,
  isPending,
  resolveTier,
  shouldEscalate,
  type Posture,
  type PostureMode,
  type Priority,
  type QueueItem,
} from "./policy.ts";
import {
  archiveItem,
  drainIncoming,
  ensureDirs,
  envelopeToItem,
  getItem,
  inboxPaths,
  listItems,
  putItem,
  readPosture,
  writePosture,
  type EnqueueEnvelope,
} from "./store.ts";

/* ============================================================================
 * INBOX — annotated, queued, policy-delivered out-of-band messages for pi
 * ============================================================================
 *
 * The inbox works by CONVENTION, not interception: pi's injection is push-only
 * (no veto hook — RESEARCH-inbox-feasibility.md), so senders ENQUEUE here
 * instead of calling pi.sendMessage directly, and this extension owns the
 * delivery policy. Real user messages and tool results NEVER pass through the
 * inbox — that's architecture, not policy. See PROTOCOL.md for the full design.
 *
 * Responsibilities:
 *   - own the durable queue (store.ts) and drain cross-process enqueues
 *   - track posture (available/busy) and show it in the footer AT ALL TIMES
 *   - run a scheduler tick that delivers items by tier × posture (policy.ts)
 *   - surface the queue: widget (count + top priority) + /peek + /ack
 *
 * No blocking work in hooks; the only timer is a session-scoped setInterval
 * started in session_start and cleared in session_shutdown.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.dirname(HERE);
const REPO = path.dirname(EXT_DIR);
const INBOX_ROOT = process.env.FAMILIAR_INBOX_DIR || path.join(REPO, "state", "inbox");

const TICK_MS = 15_000;
const CFG = DEFAULT_CONFIG;

const PRI_LABEL = (p: Priority) => `P${p}`;

function ageStr(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Parse "--in 30m" / "--at 2026-08-20T15:00" style durations to a deadline. */
export function parseWhen(spec: string, now = Date.now()): number | undefined {
  const s = spec.trim();
  const dur = s.match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)?$/i);
  if (dur) {
    const n = Number(dur[1]);
    const unit = (dur[2] || "m").toLowerCase();
    const mult = unit.startsWith("s") ? 1000
      : unit.startsWith("h") ? 3600_000
      : unit.startsWith("d") ? 86400_000
      : 60_000;
    return now + n * mult;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

export default function (pi: ExtensionAPI) {
  const P = inboxPaths(INBOX_ROOT);

  // In-memory posture inputs. Persisted mode survives restart; activity is
  // re-seeded on session_start (a fresh session starts "busy" until settled).
  let postureMode: PostureMode = "auto";
  let lastActivity = Date.now();
  let agentBusy = false;
  let idleSince = Date.now();
  let ctxRef: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      errorLog("inbox", { handlerError: String(err) });
    }
  };

  const currentPosture = (): Posture =>
    inferPosture(
      { mode: postureMode, lastActivity, agentBusy, now: Date.now() },
      CFG,
    );

  const idleForMs = (): number => (agentBusy ? 0 : Date.now() - idleSince);

  /* --- ambient surfaces: footer posture + inbox widget ------------------- */

  const renderPosture = () => {
    if (!ctxRef?.hasUI) return;
    const p = currentPosture();
    const glyph = p === "available" ? "◉" : "◌";
    const modeTag = postureMode === "auto" ? "" : " (manual)";
    ctxRef.ui.setStatus("inbox-posture", `${glyph} ${p}${modeTag}`);
  };

  const renderWidget = () => {
    if (!ctxRef?.hasUI) return;
    const pending = listItems(P).filter(isPending);
    if (pending.length === 0) {
      ctxRef.ui.setWidget("inbox", undefined);
      return;
    }
    const top = pending.reduce<Priority>((m, it) => (it.priority < m ? it.priority : m), 3 as Priority);
    // Widget lives directly above the editor — pi has no top-right widget slot
    // for extensions (see PROTOCOL.md § Widget). This is the closest ambient
    // rail: visible to both Kevin and the agent, present IFF non-empty.
    ctxRef.ui.setWidget("inbox", [`📥 ${pending.length} (${PRI_LABEL(top)})`]);
  };

  const refreshSurfaces = () => {
    renderPosture();
    renderWidget();
  };

  /* --- delivery ---------------------------------------------------------- */

  const deliverBody = (item: QueueItem, opts: { steer: boolean; autoAck: boolean }) => {
    const lines = [
      `<inbox-item id="${item.id}" type="${item.type}" priority="${PRI_LABEL(item.priority)}" source="${item.source}">`,
      item.body || item.summary,
      `</inbox-item>`,
    ];
    pi.sendMessage(
      { customType: "inbox-item", content: lines.join("\n"), display: true },
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

  // The linger digest: a single line for ALL lingering items, never one-per.
  const deliverDigest = (items: QueueItem[]) => {
    const lines = items.map(
      (it) => `  • ${PRI_LABEL(it.priority)} ${it.summary} — /ack ${it.id}`,
    );
    pi.sendMessage(
      {
        customType: "inbox-digest",
        content: `<inbox-digest count="${items.length}">\n${lines.join("\n")}\n</inbox-digest>`,
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
    ensureDirs(P);
    const created = drainIncoming(P);
    const now = Date.now();
    const posture = currentPosture();

    let dirtySurfaces = created.length > 0;
    const items = listItems(P).filter(isPending);
    const lingerBatch: QueueItem[] = [];

    for (const item of items) {
      // Advisory escalation: latch once when the deadline passes.
      if (shouldEscalate(item, now)) {
        item.escalated = true;
        putItem(P, item);
        dirtySurfaces = true;
      }

      const action = decideAction(item, { posture, now, idleForMs: idleForMs() }, CFG);
      switch (action) {
        case "deliver-steer":
          deliverBody(item, { steer: true, autoAck: true });
          dirtySurfaces = true;
          break;
        case "deliver-wait":
          deliverBody(item, { steer: false, autoAck: true });
          dirtySurfaces = true;
          break;
        case "digest":
          lingerBatch.push(item);
          break;
        case "nudge":
        case "hold":
          break;
      }
    }

    if (lingerBatch.length > 0) {
      deliverDigest(lingerBatch);
      dirtySurfaces = true;
    }
    if (dirtySurfaces) refreshSurfaces();
  };

  const tickGuarded = () => guard(tick);

  /* --- exported in-process enqueue API ----------------------------------- */
  // Other extensions import { enqueue } and call it directly (same process).
  // This is enqueue path (a) from the protocol; familiar.sh is path (b).
  const enqueue = (env: EnqueueEnvelope): QueueItem => {
    ensureDirs(P);
    const item = envelopeToItem(env);
    putItem(P, item);
    refreshSurfaces();
    return item;
  };
  // Publish on the shared bus too, so senders can fire-and-forget without an
  // import cycle: pi.events.emit("inbox:add", envelope).
  pi.events.on("inbox:add", (env: EnqueueEnvelope) => guard(() => enqueue(env)));

  /* --- commands ---------------------------------------------------------- */

  pi.registerCommand("peek", {
    description: "Inbox: show the queue snapshot (does not deliver or ack)",
    handler: async (_args, ctx) => {
      const items = listItems(P).filter(isPending);
      if (items.length === 0) {
        ctx.ui.notify("📥 inbox empty", "info");
        return;
      }
      const posture = currentPosture();
      const rows = items
        .sort((a, b) => a.priority - b.priority || a.ts - b.ts)
        .map((it) => {
          const tier = resolveTier(it, posture, CFG);
          const dl = it.suggested_deadline
            ? ` due:${new Date(it.suggested_deadline).toLocaleTimeString()}`
            : "";
          return `${PRI_LABEL(it.priority)} [${it.type}] ${it.id}  ${ageStr(it.ts)}  ${tier}${dl}\n    ${it.summary}`;
        });
      ctx.ui.notify(`📥 inbox (${items.length}, posture: ${posture})\n${rows.join("\n")}`, "info");
    },
  });

  pi.registerCommand("ack", {
    description: "Inbox: acknowledge nudged item(s) and inject full body. /ack [id|all]",
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
        ctx.ui.notify(arg ? `no pending item "${arg}"` : "📥 nothing to ack", "warning");
        return;
      }
      // Ack delivers the full body as a followUp (it's a courtesy read, not an
      // interrupt) and resolves the item.
      for (const it of targets) {
        deliverBody(it, { steer: false, autoAck: true });
      }
      refreshSurfaces();
      ctx.ui.notify(`📥 acked ${targets.length} item(s)`, "info");
    },
  });

  pi.registerCommand("remind", {
    description: "Inbox: enqueue a self-reminder. /remind <text> [--at <time>|--in <duration>]",
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
        `📥 reminder queued (${item.id})${deadline ? ` due ${new Date(deadline).toLocaleString()}` : ""}`,
        "info",
      );
    },
  });

  pi.registerCommand("posture", {
    description: "Inbox: show/set posture. /posture [busy|available|auto]",
    getArgumentCompletions: (prefix) => {
      const opts = ["auto", "available", "busy"].map((v) => ({ value: v, label: v }));
      const f = opts.filter((o) => o.value.startsWith(prefix));
      return f.length ? f : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "") {
        ctx.ui.notify(`posture: ${currentPosture()} (mode: ${postureMode})`, "info");
        return;
      }
      if (arg !== "auto" && arg !== "available" && arg !== "busy") {
        ctx.ui.notify("usage: /posture [busy|available|auto]", "warning");
        return;
      }
      postureMode = arg as PostureMode;
      writePosture(P, { mode: postureMode });
      refreshSurfaces();
      ctx.ui.notify(`posture → ${arg} (now: ${currentPosture()})`, "info");
    },
  });

  pi.registerCommand("snooze", {
    description: "Inbox: suppress an item for a duration. /snooze <id> <duration>",
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
      ctx.ui.notify(`📥 snoozed ${id} until ${new Date(until).toLocaleTimeString()}`, "info");
    },
  });

  /* --- nudge prefix injection (rides the next turn, no prefix-cache churn) */
  // A "nudge"-tier item surfaces as a one-line prefix on the NEXT turn. We
  // inject via before_agent_start (like timegap.ts) so it's appended, never
  // triggers a turn, and only appears when Kevin/agent is already talking.
  pi.on("before_agent_start", async () => {
    const now = Date.now();
    const posture = currentPosture();
    const nudges = listItems(P)
      .filter(isPending)
      .filter((it) => decideAction(it, { posture, now, idleForMs: idleForMs() }, CFG) === "nudge");
    if (nudges.length === 0) return;

    for (const it of nudges) {
      it.surfacedCount = (it.surfacedCount ?? 0) + 1;
      putItem(P, it);
    }
    const lines = nudges.map((it) => `📥 inbox: ${it.summary} — /ack ${it.id} for details`);
    return {
      message: {
        customType: "inbox-nudge",
        content: `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`,
        display: false,
      },
    };
  });

  /* --- posture signal wiring --------------------------------------------- */

  pi.on("input", async () => {
    // Any user message activity → busy (message-receipt trigger; see
    // PROTOCOL.md § Typing detection for why we don't hook keystrokes).
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
    guard(() => ensureDirs(P));
    postureMode = readPosture(P).mode;
    // A fresh/reloaded session starts "busy" until it settles: safer to hold a
    // low-priority item than to dump the queue into a just-resumed agent.
    lastActivity = Date.now();
    idleSince = Date.now();
    agentBusy = false;
    refreshSurfaces();
    if (timer) clearInterval(timer);
    timer = setInterval(tickGuarded, TICK_MS);
    tickGuarded();
  });

  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });

  // Exported for other same-process extensions: `import { ... } from "../inbox/index.ts"`
  // is not how pi loads extensions, so the durable seam is pi.events / the
  // familiar.sh drop-box. We still return the helper for direct SDK embeds.
  return { enqueue };
}

/** Programmatic enqueue for embedders that hold the ExtensionAPI (rare). */
export type { EnqueueEnvelope } from "./store.ts";
