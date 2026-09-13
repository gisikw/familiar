import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { errorLog } from "../lib/debug.ts";
import {
  DEFAULT_CONFIG,
  decideAction,
  dndActive,
  makeDnd,
  parseWhen,
  parseDurationMs,
  isPending,
  isLive,
  resolveTier,
  shouldEscalate,
  type DndActor,
  type DndState,
  type Priority,
  type QueueItem,
} from "./policy.ts";
import {
  acknowledgeItem,
  archiveItem,
  drainAcknowledgements,
  drainIncoming,
  ensureDirs,
  enqueueEnvelopeIdempotent,
  getArchivedItem,
  getItem,
  worklistPaths,
  listItems,
  putItem,
  readDnd,
  writeDnd,
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

/* Durable synthetic-turn queue. Real user input never passes through this
 * extension and is therefore always delivered immediately, including in DND. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(path.dirname(HERE));
const WORKLIST_ROOT = process.env.FAMILIAR_WORKLIST_DIR || process.env.FAMILIAR_INBOX_DIR || path.join(REPO, "state", "worklist");
const LEGACY_ROOT = path.join(REPO, "state", "inbox");
const TICK_MS = 15_000;
const CFG = DEFAULT_CONFIG;
const PRI_LABEL = (p: Priority) => `P${p}`;

function ageStr(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
function remainStr(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}
export { parseWhen, parseDurationMs } from "./policy.ts";

export default function (pi: ExtensionAPI) {
  const P = worklistPaths(WORKLIST_ROOT);
  let dnd: DndState | null = null;
  let agentBusy = false;
  let idleSince = Date.now();
  let ctxRef: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sinkDisposer: (() => void) | undefined;
  let lastDigestReminderAt = 0;
  const tombstones = new Set<string>();

  const guard = (fn: () => void) => { try { fn(); } catch (err) { errorLog("worklist", { handlerError: String(err) }); } };
  const idleForMs = () => agentBusy ? 0 : Date.now() - idleSince;
  const active = (now = Date.now()) => dndActive(dnd, now);

  const announceFreshWork = (items: QueueItem[]) => {
    if (!items.length) return;
    pi.events.emit("familiar:fresh-input", { source: "worklist", at: Math.max(...items.map((item) => item.ts)) });
  };

  /** Expiry is checked at every policy boundary, not delegated to the timer. */
  const expireIfElapsed = (now = Date.now()) => {
    if (dnd && !dndActive(dnd, now)) {
      dnd = null;
      writeDnd(P, null);
      return true;
    }
    return false;
  };

  const render = () => {
    if (!ctxRef?.hasUI) return;
    const now = Date.now();
    const enabled = active(now);
    const text = enabled && dnd ? `● DND ${remainStr(dnd.expiresAt - now)}` : "○ DND off";
    ctxRef.ui.setStatus("dnd", text);
    pi.events.emit("familiar:dnd", { text, enabled, expiresAt: enabled ? dnd?.expiresAt : undefined });
    const pending = listItems(P).filter(isPending);
    if (!pending.length) return ctxRef.ui.setWidget("worklist", undefined);
    const top = pending.reduce<Priority>((p, item) => item.priority < p ? item.priority : p, 3);
    ctxRef.ui.setWidget("worklist", [enabled ? `📋 ${pending.length} queued (${PRI_LABEL(top)}) · DND` : `📋 ${pending.length} (${PRI_LABEL(top)})`]);
  };

  const resolveAck = (item: QueueItem) => {
    item.delivered = true;
    item.acked = true;
    putItem(P, item);
    archiveItem(P, item.id);
  };
  const deliverBody = (item: QueueItem, steer: boolean) => {
    pi.sendMessage({
      customType: "worklist-item",
      content: `<worklist-item id="${item.id}" type="${item.type}" priority="${PRI_LABEL(item.priority)}" source="${item.source}">\n${item.body || item.summary}\n</worklist-item>`,
      display: true,
    }, steer ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "followUp" });
    resolveAck(item);
  };
  const deliverDigest = (items: QueueItem[]) => {
    const lines = items.map((item) => `  • ${PRI_LABEL(item.priority)} ${item.summary} — agent: ack_worklist id="${item.id}"; user: /ack ${item.id}`);
    pi.sendMessage({ customType: "worklist-digest", content: `<worklist-digest count="${items.length}">\n${lines.join("\n")}\n</worklist-digest>`, display: true }, { deliverAs: "followUp" });
    const now = Date.now();
    for (const item of items) {
      item.digested = true;
      item.digestedAt ??= now;
      putItem(P, item);
    }
  };

  /** At most one turn-triggering delivery per tick prevents an expiry herd. */
  const tick = () => {
    ensureDirs(P, LEGACY_ROOT);
    const created = drainIncoming(P);
    announceFreshWork(created);
    const acknowledged = drainAcknowledgements(P);
    const now = Date.now();
    const elapsed = expireIfElapsed(now);
    const isDnd = active(now);
    let bodyDeliveries = 0;
    const digest: QueueItem[] = [];
    const items = listItems(P).filter(isPending).sort((a, b) => a.priority - b.priority || a.ts - b.ts);
    let dirty = !!(created.length || acknowledged.length || elapsed);

    for (const item of items) {
      if (shouldEscalate(item, now)) { item.escalated = true; putItem(P, item); dirty = true; }
      if (item.digested && typeof item.digestedAt !== "number") { item.digestedAt = now; putItem(P, item); dirty = true; }
      const action = decideAction(item, { dnd: isDnd, now, idleForMs: idleForMs() }, CFG);
      if ((action === "deliver-steer" || action === "deliver-wait") && bodyDeliveries < CFG.maxDeliveriesPerTick) {
        deliverBody(item, true);
        bodyDeliveries++;
        dirty = true;
      } else if (action === "digest" && bodyDeliveries === 0) {
        digest.push(item);
      }
    }
    if (digest.length) { deliverDigest(digest); dirty = true; }
    if (dirty || ctxRef?.hasUI) render();
  };
  const tickGuarded = () => guard(tick);

  const enqueue = (env: EnqueueEnvelope): QueueItem => {
    ensureDirs(P, LEGACY_ROOT);
    const result = enqueueEnvelopeIdempotent(P, env);
    if (result.created) { announceFreshWork([result.item]); render(); }
    return result.item;
  };

  const sink: DurableSink = {
    async enqueue(env: DurableEnqueueEnvelope): Promise<DurableAcceptance> {
      ensureDirs(P, LEGACY_ROOT);
      if (env.id && tombstones.has(env.id)) return { accepted: false, superseded: true, id: env.id, reason: "withdrawn before enqueue" };
      const result = enqueueEnvelopeIdempotent(P, {
        id: env.id, priority: env.priority, type: (env.type as QueueItem["type"]) ?? "notify",
        summary: env.summary, body: env.body, source: env.source ?? "subagent",
        ...(typeof env.suggested_deadline === "number" ? { suggested_deadline: env.suggested_deadline } : {}),
      });
      if (result.created) { announceFreshWork([result.item]); render(); }
      return { accepted: true, id: result.item.id };
    },
    async acknowledge(id: string) { tombstones.add(id); const ok = acknowledgeItem(P, id); render(); return ok; },
    async withdraw(id: string) {
      tombstones.add(id);
      const item = getItem(P, id);
      if (!item) {
        const archived = getArchivedItem(P, id);
        return !archived || archived.withdrawn === true || !(archived.delivered || archived.acked);
      }
      if (item.delivered || item.acked) return false;
      item.withdrawn = true; putItem(P, item); archiveItem(P, id); render(); return true;
    },
  };

  try { ensureDirs(P, LEGACY_ROOT); sinkDisposer = registry.register<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION, sink); }
  catch (err) { errorLog("worklist", { storageDisabled: String(err) }); }
  pi.events.on("worklist:add", (env: unknown) => guard(() => enqueue(env as EnqueueEnvelope)));
  pi.events.on("inbox:add", (env: unknown) => guard(() => enqueue(env as EnqueueEnvelope)));

  /** Shared authoritative state operation for user command and Familiar tool. */
  const setDnd = (actor: DndActor, durationMs?: number, now = Date.now()) => {
    const next = makeDnd(actor, durationMs, now, CFG);
    if (!next) return null;
    dnd = next;
    writeDnd(P, dnd);
    render();
    return next;
  };
  const clearDnd = () => { dnd = null; writeDnd(P, null); render(); };

  pi.registerCommand("peek", {
    description: "Show queued synthetic work without delivering or acknowledging it",
    handler: async (_args, ctx) => {
      const items = listItems(P).filter(isPending).sort((a, b) => a.priority - b.priority || a.ts - b.ts);
      if (!items.length) return ctx.ui.notify("📋 worklist empty", "info");
      const rows = items.map((item) => `${PRI_LABEL(item.priority)} [${item.type}] ${item.id}  ${ageStr(item.ts)}  ${resolveTier(item, CFG)}\n    ${item.summary}`);
      ctx.ui.notify(`📋 worklist (${items.length}${active() ? ", DND" : ""})\n${rows.join("\n")}`, "info");
    },
  });
  pi.registerCommand("ack", {
    description: "Acknowledge queued work and show its full body. /ack [id|all]",
    handler: async (args, ctx) => {
      const arg = args.trim();
      const pending = listItems(P).filter(isPending);
      const targets = !arg || arg === "all" ? pending : pending.filter((item) => item.id === arg);
      if (!targets.length) return ctx.ui.notify(arg ? `no pending item "${arg}"` : "📋 nothing to ack", "warning");
      for (const item of targets) deliverBody(item, false);
      render();
      ctx.ui.notify(`📋 acked ${targets.length} item(s)`, "info");
    },
  });
  pi.registerCommand("remind", {
    description: "Queue a reminder. /remind <text> [--at <time>|--in <duration>]",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) return ctx.ui.notify("usage: /remind <text> [--in 30m | --at 15:00]", "warning");
      let text = raw; let deadline: number | undefined;
      const match = raw.match(/\s--(in|at)\s+(.+)$/);
      if (match) { text = raw.slice(0, match.index).trim(); deadline = parseWhen(match[2]); }
      const item = enqueue({ priority: 2, type: "notify", summary: text, body: text, source: "remind", ...(deadline ? { suggested_deadline: deadline } : {}) });
      ctx.ui.notify(`📋 reminder queued (${item.id})`, "info");
    },
  });

  pi.registerCommand("snooze", {
    description: "Keep one queued item quiet for a duration. /snooze <id> <duration>",
    handler: async (args, ctx) => {
      const [id, spec] = args.trim().split(/\s+/);
      if (!id || !spec) return ctx.ui.notify("usage: /snooze <id> <duration e.g. 30m>", "warning");
      const queued = getItem(P, id);
      if (!queued) return ctx.ui.notify(`no item "${id}"`, "warning");
      const until = parseWhen(spec);
      if (!until || until <= Date.now()) return ctx.ui.notify(`bad duration "${spec}"`, "warning");
      queued.snoozedUntil = until;
      putItem(P, queued);
      render();
      ctx.ui.notify(`📋 snoozed ${id} until ${new Date(until).toLocaleTimeString()}`, "info");
    },
  });

  const DURATION_HINTS = ["15m", "30m", "1h", "2h"];
  pi.registerCommand("dnd", {
    description: "Toggle Do Not Disturb. /dnd [off|duration] (default: 30m)",
    getArgumentCompletions: (prefix) => {
      const options = ["off", ...DURATION_HINTS].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return options.length ? options : null;
    },
    handler: async (args, ctx) => {
      const spec = args.trim().toLowerCase();
      if (spec === "off" || spec === "clear" || (!spec && active())) {
        clearDnd(); ctx.ui.notify("Do Not Disturb off", "info"); return;
      }
      const duration = spec ? parseDurationMs(spec) : undefined;
      if (spec && duration === undefined) return ctx.ui.notify(`bad duration "${spec}"`, "warning");
      const state = setDnd("user", duration);
      if (!state) return ctx.ui.notify("duration must be greater than zero", "warning");
      ctx.ui.notify(`Do Not Disturb on until ${new Date(state.expiresAt).toLocaleTimeString()}`, "info");
    },
  });

  // Keep the established tool name so existing calls do not break; its public
  // schema and copy expose only the single DND toggle. Legacy level arguments
  // are accepted inside execute for a bounded compatibility migration.
  pi.registerTool({
    name: "set_attention",
    label: "Set Do Not Disturb",
    description: "Turn Do Not Disturb on or off. While on, user messages still arrive normally; synthetic turns, settlements, and reminders remain durably queued until clear or expiry. It defaults to 30 minutes. You may request a duration up to two hours and may clear it immediately.",
    promptSnippet: "Toggle Do Not Disturb for synthetic turns; user messages are never delayed",
    promptGuidelines: ["Use Do Not Disturb only when an uninterrupted conversation is explicitly useful. Clearing it resumes paced delivery of durable queued work."],
    parameters: Type.Object({
      enabled: Type.Boolean({ description: "true to enable Do Not Disturb; false to clear it immediately" }),
      duration_minutes: Type.Optional(Type.Number({ description: "Optional duration when enabling; defaults to 30 minutes and is capped at 120 minutes", minimum: 0 })),
    }),
    async execute(_id, params: { enabled?: boolean; duration_minutes?: number; level?: string }) {
      const result = (details: Record<string, unknown>, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details, ...(isError ? { isError: true } : {}) });
      // Old auto/available permitted ordinary delivery, so both map to off;
      // old focused/protected suppression maps to the one DND mode.
      const enabled = typeof params.enabled === "boolean"
        ? params.enabled
        : params.level === "auto" || params.level === "available"
          ? false
          : params.level === "focused" || params.level === "protected"
            ? true
            : undefined;
      if (enabled === false) { clearDnd(); return result({ ok: true, enabled: false }); }
      if (enabled !== true) return result({ ok: false, error: "enabled must be true or false" }, true);
      const requested = params.duration_minutes === undefined ? undefined : params.duration_minutes * 60_000;
      const state = setDnd("familiar", requested);
      if (!state) return result({ ok: false, error: "duration_minutes must be greater than zero" }, true);
      return result({ ok: true, enabled: true, expires_at: new Date(state.expiresAt).toISOString(), minutes: Math.round((state.expiresAt - Date.now()) / 60_000) });
    },
  });

  pi.registerTool({
    name: "ack_worklist", label: "Acknowledge Worklist Item",
    description: "Read and acknowledge queued synthetic work. Returns each full body inline and archives it without duplicate injection.",
    promptSnippet: "Read and resolve queued worklist items",
    parameters: Type.Object({ id: Type.Optional(Type.String({ description: "Item id, or all/omitted for every pending item" })) }),
    async execute(_id, params: { id?: string }) {
      const arg = (params.id ?? "").trim();
      const pending = listItems(P).filter(isPending);
      const targets = !arg || arg === "all" ? pending : pending.filter((item) => item.id === arg);
      const acked = targets.map((item) => { resolveAck(item); return { id: item.id, priority: PRI_LABEL(item.priority), type: item.type, source: item.source, summary: item.summary, body: item.body || item.summary }; });
      if (acked.length) render();
      const details = arg && arg !== "all" && !acked.length ? { ok: false, error: `no pending worklist item "${arg}"`, acked: [] } : { ok: true, count: acked.length, acked };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, ...(details.ok ? {} : { isError: true }) };
    },
  });

  // User activity is deliberately not a DND lease: observing a real turn must
  // neither delay that turn nor extend/clear the explicit wall-clock state.
  pi.on("input", async () => { guard(render); });
  pi.on("agent_start", async () => { agentBusy = true; guard(render); });
  pi.on("agent_settled", async () => {
    agentBusy = false;
    idleSince = Date.now();
    guard(render);
    tickGuarded();
  });

  pi.on("before_agent_start", async () => {
    const now = Date.now();
    expireIfElapsed(now);
    if (active(now)) return; // no synthetic prefix may hitchhike on a fresh user turn
    const live = listItems(P).filter(isPending);
    const nudges = live.filter((item) => decideAction(item, { dnd: false, now, idleForMs: idleForMs() }, CFG) === "nudge");
    const owed = now - lastDigestReminderAt >= CFG.digestReminderMs ? live.filter((item) => isLive(item, now) && item.digested && !item.acked) : [];
    if (!nudges.length && !owed.length) return;
    for (const item of nudges) { item.surfacedCount = (item.surfacedCount ?? 0) + 1; putItem(P, item); }
    const lines = nudges.map((item) => `📋 worklist: ${item.summary} — call ack_worklist id="${item.id}" for details`);
    if (owed.length) { lastDigestReminderAt = now; lines.push(`📋 ${owed.length} queued item(s) still need acknowledgement: ${owed.map((item) => item.id).join(", ")}`); }
    return { message: { customType: "worklist-nudge", content: `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`, display: false } };
  });

  // User activity neither extends nor clears DND. Pi owns real-user delivery.
  pi.on("input", async () => guard(render));
  pi.on("agent_start", async () => { agentBusy = true; guard(render); });
  pi.on("agent_settled", async () => { agentBusy = false; idleSince = Date.now(); guard(render); tickGuarded(); });
  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    guard(() => {
      ensureDirs(P, LEGACY_ROOT);
      dnd = readDnd(P);
      expireIfElapsed();
      agentBusy = false; idleSince = Date.now();
      announceFreshWork(listItems(P).filter(isPending));
      render();
      if (!sinkDisposer) sinkDisposer = registry.register<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION, sink);
    });
    if (timer) clearInterval(timer);
    timer = setInterval(tickGuarded, TICK_MS);
    tickGuarded();
  });
  pi.on("session_shutdown", async () => { if (timer) clearInterval(timer); timer = undefined; sinkDisposer?.(); sinkDisposer = undefined; });

  return { enqueue, sink, tick, setDnd, clearDnd, isDnd: active };
}

export type { EnqueueEnvelope } from "./store.ts";
