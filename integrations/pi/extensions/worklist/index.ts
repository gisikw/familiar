import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errorLog } from "../lib/debug.ts";
import {
  DEFAULT_CONFIG, decideAction, dndActive, parseWhen, parseDurationMs, isPending, isLive,
  resolveTier, shouldEscalate, type DndActor, type DndState, type Priority, type QueueItem,
} from "./policy.ts";
import { WorklistClient, type EnqueueEnvelope } from "./store.ts";
import {
  registry, WORKLIST_SINK, WORKLIST_SINK_VERSION,
  type DurableSink, type DurableEnqueueEnvelope, type DurableAcceptance,
} from "../lib/capabilities.ts";

const TICK_MS = 15_000;
const CFG = DEFAULT_CONFIG;
const PRI_LABEL = (p: Priority) => `P${p}`;
export const DND_SERVICE_SYMBOL = Symbol.for("familiar.worklist.dnd.v1");
export const DND_CHANGED_EVENT = "familiar:worklist-dnd-changed";
export interface DndService {
  read(): Promise<{ enabled: false } | { enabled: true; expiresAt: number }>;
  set(enabled: boolean): Promise<{ enabled: false } | { enabled: true; expiresAt: number }>;
}
type ProcessGlobals = Record<PropertyKey, unknown>;
const processGlobals = process as unknown as ProcessGlobals;

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
  const client = new WorklistClient();
  let dnd: DndState | null = null;
  let items: QueueItem[] = [];
  let agentBusy = false;
  let idleSince = Date.now();
  let ctxRef: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sinkDisposer: (() => void) | undefined;
  let dndServiceDisposer: (() => void) | undefined;
  let lastDigestReminderAt = 0;
  let ticking = false;
  let unavailableNotified = false;
  const local = new Map<string, Partial<QueueItem>>();

  const merged = (item: QueueItem): QueueItem => ({ ...item, ...local.get(item.id) });
  const pending = () => items.map(merged).filter(isPending);
  const idleForMs = () => agentBusy ? 0 : Date.now() - idleSince;
  const active = (now = Date.now()) => dndActive(dnd, now);
  const report = (error: unknown) => {
    errorLog("worklist", { serviceError: String(error) });
    if (ctxRef?.hasUI && !unavailableNotified) {
      unavailableNotified = true;
      ctxRef.ui.notify(String(error), "error");
    }
  };
  const patch = (item: QueueItem, changes: Partial<QueueItem>) => {
    Object.assign(item, changes);
    local.set(item.id, { ...local.get(item.id), ...changes });
  };
  const announceDndChanged = () => pi.events.emit(DND_CHANGED_EVENT, active() && dnd ? { enabled: true, expiresAt: dnd.expiresAt } : { enabled: false });
  const render = () => {
    if (!ctxRef?.hasUI) return;
    const now = Date.now();
    const enabled = active(now);
    const text = enabled && dnd ? `● DND ${remainStr(dnd.expiresAt - now)}` : "○ DND off";
    ctxRef.ui.setStatus("dnd", text);
    pi.events.emit("familiar:dnd", { text, enabled, expiresAt: enabled ? dnd?.expiresAt : undefined });
    const live = pending();
    if (!live.length) return ctxRef.ui.setWidget("worklist", undefined);
    const top = live.reduce<Priority>((p, item) => item.priority < p ? item.priority : p, 3);
    ctxRef.ui.setWidget("worklist", [enabled ? `📋 ${live.length} queued (${PRI_LABEL(top)}) · DND` : `📋 ${live.length} (${PRI_LABEL(top)})`]);
  };
  const refresh = async () => {
    const [nextItems, nextDnd] = await Promise.all([client.list(), client.getDnd()]);
    items = nextItems;
    dnd = nextDnd;
    unavailableNotified = false;
  };
  const resolveAck = async (item: QueueItem) => {
    await client.ack(item.id);
    items = items.filter((value) => value.id !== item.id);
    local.delete(item.id);
  };
  const deliverBody = async (item: QueueItem, steer: boolean) => {
    pi.sendMessage({
      customType: "worklist-item",
      content: `<worklist-item id="${item.id}" type="${item.type}" priority="${PRI_LABEL(item.priority)}" source="${item.source}">\n${item.body || item.summary}\n</worklist-item>`,
      display: true,
    }, steer ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "followUp" });
    await resolveAck(item);
  };
  const deliverDigest = (digest: QueueItem[]) => {
    const lines = digest.map((item) => `  • ${PRI_LABEL(item.priority)} ${item.summary} — agent: ack_worklist id="${item.id}"; user: /ack ${item.id}`);
    pi.sendMessage({ customType: "worklist-digest", content: `<worklist-digest count="${digest.length}">\n${lines.join("\n")}\n</worklist-digest>`, display: true }, { deliverAs: "followUp" });
    const now = Date.now();
    for (const item of digest) patch(item, { digested: true, digestedAt: item.digestedAt ?? now });
  };

  /** Polling replaces the old file watcher/drain. At most one body delivery per pass. */
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await refresh();
      const now = Date.now();
      let bodyDeliveries = 0;
      const digest: QueueItem[] = [];
      for (const item of pending().sort((a, b) => a.priority - b.priority || a.ts - b.ts)) {
        if (shouldEscalate(item, now)) patch(item, { escalated: true });
        if (item.digested && typeof item.digestedAt !== "number") patch(item, { digestedAt: now });
        const action = decideAction(item, { dnd: active(now), now, idleForMs: idleForMs() }, CFG);
        if ((action === "deliver-steer" || action === "deliver-wait") && bodyDeliveries < CFG.maxDeliveriesPerTick) {
          await deliverBody(item, true);
          bodyDeliveries++;
        } else if (action === "digest" && bodyDeliveries === 0) digest.push(item);
      }
      if (digest.length) deliverDigest(digest);
      render();
    } catch (error) { report(error); }
    finally { ticking = false; }
  };

  const enqueue = async (env: EnqueueEnvelope): Promise<QueueItem> => {
    const result = await client.enqueue(env);
    if (result.created) pi.events.emit("familiar:fresh-input", { source: "worklist", at: result.item.ts });
    await refresh();
    render();
    return result.item;
  };
  const sink: DurableSink = {
    async enqueue(env: DurableEnqueueEnvelope): Promise<DurableAcceptance> {
      const result = await client.enqueue({ ...env, type: (env.type as QueueItem["type"]) ?? "notify", source: env.source ?? "subagent" });
      if (result.created) pi.events.emit("familiar:fresh-input", { source: "worklist", at: result.item.ts });
      await refresh(); render();
      return { accepted: true, id: result.item.id };
    },
    async acknowledge(id: string) {
      try { await client.ack(id); await refresh(); render(); return true; }
      catch (error) { if ((error as { code?: string }).code === "not_found") return true; throw error; }
    },
    async withdraw(id: string) {
      try { await client.withdraw(id); await refresh(); render(); return true; }
      catch (error) { if ((error as { code?: string }).code === "not_found") return true; if ((error as { code?: string }).code === "conflict") return false; throw error; }
    },
  };
  sinkDisposer = registry.register<DurableSink>(WORKLIST_SINK, WORKLIST_SINK_VERSION, sink);
  pi.events.on("worklist:add", (env: unknown) => { void enqueue(env as EnqueueEnvelope).catch(report); });
  pi.events.on("inbox:add", (env: unknown) => { void enqueue(env as EnqueueEnvelope).catch(report); });

  const setDnd = async (actor: DndActor, durationMs?: number) => {
    dnd = await client.setDnd(true, actor, durationMs);
    render(); announceDndChanged();
    return dnd;
  };
  const clearDnd = async () => {
    await client.setDnd(false, "familiar");
    dnd = null; render(); announceDndChanged();
  };
  const dndService: DndService = {
    async read() { dnd = await client.getDnd(); render(); return active() && dnd ? { enabled: true, expiresAt: dnd.expiresAt } : { enabled: false }; },
    async set(enabled) {
      if (typeof enabled !== "boolean") throw Object.assign(new Error("enabled must be boolean"), { code: "invalid_request" });
      if (!enabled) { await clearDnd(); return { enabled: false }; }
      const next = await setDnd("user");
      if (!next) throw Object.assign(new Error("DND unavailable"), { code: "unavailable" });
      return { enabled: true, expiresAt: next.expiresAt };
    },
  };
  const publishDndService = () => {
    processGlobals[DND_SERVICE_SYMBOL] = dndService;
    dndServiceDisposer = () => { if (processGlobals[DND_SERVICE_SYMBOL] === dndService) delete processGlobals[DND_SERVICE_SYMBOL]; };
  };

  pi.registerCommand("peek", { description: "Show queued synthetic work without delivering or acknowledging it", handler: async (_args, ctx) => {
    try { await refresh(); const live = pending().sort((a, b) => a.priority - b.priority || a.ts - b.ts); if (!live.length) return ctx.ui.notify("📋 worklist empty", "info");
      ctx.ui.notify(`📋 worklist (${live.length}${active() ? ", DND" : ""})\n${live.map((item) => `${PRI_LABEL(item.priority)} [${item.type}] ${item.id}  ${ageStr(item.ts)}  ${resolveTier(item, CFG)}\n    ${item.summary}`).join("\n")}`, "info");
    } catch (error) { ctx.ui.notify(String(error), "error"); }
  }});
  pi.registerCommand("ack", { description: "Acknowledge queued work and show its full body. /ack [id|all]", handler: async (args, ctx) => {
    try { await refresh(); const arg = args.trim(); const targets = !arg || arg === "all" ? pending() : pending().filter((item) => item.id === arg); if (!targets.length) return ctx.ui.notify(arg ? `no pending item "${arg}"` : "📋 nothing to ack", "warning");
      for (const item of targets) await deliverBody(item, false); render(); ctx.ui.notify(`📋 acked ${targets.length} item(s)`, "info");
    } catch (error) { ctx.ui.notify(String(error), "error"); }
  }});
  pi.registerCommand("remind", { description: "Queue a reminder. /remind <text> [--at <time>|--in <duration>]", handler: async (args, ctx) => {
    const raw = args.trim(); if (!raw) return ctx.ui.notify("usage: /remind <text> [--in 30m | --at 15:00]", "warning");
    let text = raw; let deadline: number | undefined; const match = raw.match(/\s--(in|at)\s+(.+)$/); if (match) { text = raw.slice(0, match.index).trim(); deadline = parseWhen(match[2]); }
    try { const item = await enqueue({ priority: 2, type: "notify", summary: text, body: text, source: "remind", ...(deadline ? { suggested_deadline: deadline } : {}) }); ctx.ui.notify(`📋 reminder queued (${item.id})`, "info"); }
    catch (error) { ctx.ui.notify(String(error), "error"); }
  }});
  pi.registerCommand("snooze", { description: "Keep one queued item quiet for a duration. /snooze <id> <duration>", handler: async (args, ctx) => {
    const [id, spec] = args.trim().split(/\s+/); if (!id || !spec) return ctx.ui.notify("usage: /snooze <id> <duration e.g. 30m>", "warning");
    try { await refresh(); const queued = pending().find((item) => item.id === id); if (!queued) return ctx.ui.notify(`no item "${id}"`, "warning"); const until = parseWhen(spec); if (!until || until <= Date.now()) return ctx.ui.notify(`bad duration "${spec}"`, "warning"); patch(queued, { snoozedUntil: until }); render(); ctx.ui.notify(`📋 snoozed ${id} until ${new Date(until).toLocaleTimeString()}`, "info"); }
    catch (error) { ctx.ui.notify(String(error), "error"); }
  }});
  const DURATION_HINTS = ["15m", "30m", "1h", "2h"];
  pi.registerCommand("dnd", { description: "Toggle Do Not Disturb. /dnd [off|duration] (default: 30m)", getArgumentCompletions: (prefix) => { const options = ["off", ...DURATION_HINTS].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })); return options.length ? options : null; }, handler: async (args, ctx) => {
    try { const spec = args.trim().toLowerCase(); if (spec === "off" || spec === "clear" || (!spec && active())) { await clearDnd(); ctx.ui.notify("Do Not Disturb off", "info"); return; }
      const duration = spec ? parseDurationMs(spec) : undefined; if (spec && duration === undefined) return ctx.ui.notify(`bad duration "${spec}"`, "warning"); const state = await setDnd("user", duration); if (!state) return ctx.ui.notify("duration must be greater than zero", "warning"); ctx.ui.notify(`Do Not Disturb on until ${new Date(state.expiresAt).toLocaleTimeString()}`, "info");
    } catch (error) { ctx.ui.notify(String(error), "error"); }
  }});

  pi.registerTool({ name: "set_attention", label: "Set Do Not Disturb", description: "Turn Do Not Disturb on or off. While on, user messages still arrive normally; synthetic turns, settlements, and reminders remain durably queued until clear or expiry. It defaults to 30 minutes. You may request a duration up to two hours and may clear it immediately.", promptSnippet: "Toggle Do Not Disturb for synthetic turns; user messages are never delayed", promptGuidelines: ["Use Do Not Disturb only when an uninterrupted conversation is explicitly useful. Clearing it resumes paced delivery of durable queued work."], parameters: Type.Object({ enabled: Type.Boolean(), duration_minutes: Type.Optional(Type.Number({ minimum: 0 })) }), async execute(_id, params: { enabled?: boolean; duration_minutes?: number; level?: string }) {
    const result = (details: Record<string, unknown>, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details, ...(isError ? { isError: true } : {}) });
    const enabled = typeof params.enabled === "boolean" ? params.enabled : params.level === "auto" || params.level === "available" ? false : params.level === "focused" || params.level === "protected" ? true : undefined;
    try { if (enabled === false) { await clearDnd(); return result({ ok: true, enabled: false }); } if (enabled !== true) return result({ ok: false, error: "enabled must be true or false" }, true); const state = await setDnd("familiar", params.duration_minutes === undefined ? undefined : params.duration_minutes * 60_000); if (!state) return result({ ok: false, error: "duration_minutes must be greater than zero" }, true); return result({ ok: true, enabled: true, expires_at: new Date(state.expiresAt).toISOString(), minutes: Math.round((state.expiresAt - Date.now()) / 60_000) }); }
    catch (error) { return result({ ok: false, error: String(error) }, true); }
  }});
  pi.registerTool({ name: "ack_worklist", label: "Acknowledge Worklist Item", description: "Read and acknowledge queued synthetic work. Returns each full body inline and archives it without duplicate injection.", promptSnippet: "Read and resolve queued worklist items", parameters: Type.Object({ id: Type.Optional(Type.String()) }), async execute(_id, params: { id?: string }) {
    try { await refresh(); const arg = (params.id ?? "").trim(); const targets = !arg || arg === "all" ? pending() : pending().filter((item) => item.id === arg); const acked = []; for (const item of targets) { await resolveAck(item); acked.push({ id: item.id, priority: PRI_LABEL(item.priority), type: item.type, source: item.source, summary: item.summary, body: item.body || item.summary }); } if (acked.length) render(); const details = arg && arg !== "all" && !acked.length ? { ok: false, error: `no pending worklist item "${arg}"`, acked: [] } : { ok: true, count: acked.length, acked }; return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, ...(details.ok ? {} : { isError: true }) }; }
    catch (error) { const details = { ok: false, error: String(error), acked: [] }; return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details, isError: true }; }
  }});

  pi.on("input", async () => render());
  pi.on("agent_start", async () => { agentBusy = true; render(); });
  pi.on("agent_settled", async () => { agentBusy = false; idleSince = Date.now(); render(); await tick(); });
  pi.on("before_agent_start", async () => {
    try { await refresh(); const now = Date.now(); if (active(now)) return; const live = pending(); const nudges = live.filter((item) => decideAction(item, { dnd: false, now, idleForMs: idleForMs() }, CFG) === "nudge"); const owed = now - lastDigestReminderAt >= CFG.digestReminderMs ? live.filter((item) => isLive(item, now) && item.digested && !item.acked) : []; if (!nudges.length && !owed.length) return; for (const item of nudges) patch(item, { surfacedCount: (item.surfacedCount ?? 0) + 1 }); const lines = nudges.map((item) => `📋 worklist: ${item.summary} — call ack_worklist id="${item.id}" for details`); if (owed.length) { lastDigestReminderAt = now; lines.push(`📋 ${owed.length} queued item(s) still need acknowledgement: ${owed.map((item) => item.id).join(", ")}`); } return { message: { customType: "worklist-nudge", content: `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`, display: false } }; }
    catch (error) { report(error); return; }
  });
  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx; if (!dndServiceDisposer) publishDndService(); agentBusy = false; idleSince = Date.now(); if (!sinkDisposer) sinkDisposer = registry.register(WORKLIST_SINK, WORKLIST_SINK_VERSION, sink);
    try { await refresh(); render(); announceDndChanged(); } catch (error) { report(error); }
    if (timer) clearInterval(timer); timer = setInterval(() => { void tick(); }, TICK_MS); void tick();
  });
  pi.on("session_shutdown", async () => { if (timer) clearInterval(timer); timer = undefined; sinkDisposer?.(); sinkDisposer = undefined; dndServiceDisposer?.(); dndServiceDisposer = undefined; });
  return { enqueue, sink, tick, setDnd, clearDnd, isDnd: active };
}

export type { EnqueueEnvelope } from "./store.ts";
