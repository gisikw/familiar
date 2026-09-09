import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BackgroundHost } from "../../../../packages/background/host.mjs";
import { acquireHostLease } from "../../../../packages/background/lease.mjs";
import { bounded, LIMITS } from "../../../../packages/background/protocol.mjs";
import { createBranchRuntime } from "./runtime.ts";
import { GolemClient } from "../../../../contrib/familiar/pi/agents/api.ts";

export default function background(pi: ExtensionAPI) {
  let host: BackgroundHost | undefined;
  let lease: Awaited<ReturnType<typeof acquireHostLease>> | undefined;
  let context: ExtensionContext | undefined;
  let subscription: Promise<void> | undefined;
  let rejoinTimer: ReturnType<typeof setInterval> | undefined;
  const stopping = new AbortController();
  const client = new GolemClient();
  let pendingCurrent: { content: unknown; userId: string; projectId: string; admissionId: string } | undefined;
  const snapshot = () => {
    lease?.assertOwned();
    if (!context) throw new Error("Background owner unavailable");
    const entries = context.sessionManager.getBranch();
    bounded(entries, LIMITS.contextBytes, "canonical snapshot");
    let privateSpan = false;
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "familiar-ui/transcript-visibility")
        privateSpan = (entry.data as any)?.visibility !== "public";
    }
    return { sessionId: context.sessionManager.getSessionId(), leafId: context.sessionManager.getLeafId(),
      cwd: context.cwd, idle: context.isIdle() && (pi as any).isRuntimeControlAvailable(), private: privateSpan, entries,
      messages: buildSessionContext(entries, context.sessionManager.getLeafId()).messages };
  };
  const publish = () => pi.events.emit("familiar:background:changed", {});
  const fail = () => { context?.ui.notify("Background operation requires inspection; no automatic replay", "warning"); publish(); };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || host || process.env.FAMILIAR_BACKGROUND_ENABLE !== "1") return;
    if (typeof (pi as any).commitRuntimeControl !== "function") return;
    context = ctx;
    const state = process.env.FAMILIAR_BACKGROUND_STATE_DIR;
    // No ambient fallback: the Familiar launcher must supply a private host root.
    if (!state) return;
    mkdirSync(state, { recursive: true, mode: 0o700 });
    lease = await acquireHostLease(state);
    const providerPath = process.env.FAMILIAR_BACKGROUND_PROVIDER_EXTENSION ?? fileURLToPath(new URL("../tiamat/index.ts", import.meta.url));
    host = new BackgroundHost({ root: state, owner: {
      available: () => (pi as any).isRuntimeControlAvailable(),
      snapshot,
      commit: (sessionId: string, leafId: string | null, entries: any[]) => {
        lease!.assertOwned();
        const ids = (pi as any).commitRuntimeControl(sessionId, leafId, entries);
        publish();
        return ids;
      },
    }, createRuntime: (record: any, owner: any) => createBranchRuntime(record, owner, ctx.model, providerPath, client), onError: fail, onChange: publish });
    // One host-owned subscription. Coalesce invalidations by owned job before
    // any asynchronous detail fetch; foreign events never enter a branch queue.
    const invalidations = new Map<string, any>();
    let draining = false;
    const drain = async () => {
      if (draining) return;
      draining = true;
      try {
        while (invalidations.size && host && !stopping.signal.aborted) {
          const [jobId, event] = invalidations.entries().next().value!;
          invalidations.delete(jobId);
          for (const [key, lane] of host.scheduler.live) {
            if (lane.retiring || !lane.runtime.children) continue;
            if (await lane.runtime.children.observe(event)) {
              host.scheduler.steer(key, lane.generation, `child-${jobId}-${event.seq}`, JSON.stringify({ type: "background.child.invalidated", jobId, seq: event.seq, instruction: "Inspect owned status, handle questions, and review this exact event before rejoin." }));
              publish();
            }
          }
        }
      } catch { fail(); } finally { draining = false; }
    };
    subscription = (async () => {
      while (!stopping.signal.aborted) {
        try {
          await client.streamEvents(0, (event) => {
            if (!host || !Number.isSafeInteger(event.seq)) return;
            if (!host.store.list().some((r: any) => r.status === "running" && r.children.some((c: any) => c.jobId === event.job_id))) return;
            invalidations.set(event.job_id, event);
            void drain();
          }, stopping.signal);
        } catch { /* reconnect uses each child's durable event sequence */ }
        if (!stopping.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })();
    rejoinTimer = setInterval(() => { try { host?.flushRejoins(); } catch { fail(); } }, 250);
    rejoinTimer.unref?.();
    registerForegroundTool();
    publish();
  });

  // In-process capability discovery only. The browser cannot provide callbacks
  // or invoke pi commands: its bridge constructs this envelope after validation.
  pi.events.on("familiar:background:discover", (value: any) => {
    if (!host || host.closed) return;
    value.accept({
      admit: (request: any) => { const receipt = host!.admit(request); publish(); return receipt; },
      list: () => host!.store.list().map((r: any) => host!.inspect(r.id)),
      control: async (request: any) => {
        const h = host!;
        if (request.action === "cancel") h.scheduler.cancel(request.workstreamId, request.generation, "operator cancellation");
        else if (request.action === "steer") h.scheduler.steer(request.workstreamId, request.generation, request.commandId, request.text);
        else if (request.action === "rejoin") h.rejoin(request.workstreamId, request.generation, request.packetId, request.expectedLeafId);
        else if (["answer-child", "steer-child", "cancel-child"].includes(request.action)) {
          const children = h.scheduler.lane(request.workstreamId, request.generation).runtime.children;
          children.owned(request.jobId);
          if (request.action === "answer-child") await children.answer(request.jobId, request.questionId, request.commandId, request.text);
          if (request.action === "steer-child") await client.steer(request.jobId, request.text);
          if (request.action === "cancel-child") await children.cancel(request.jobId);
        } else throw new Error("unknown Background action");
        publish();
      },
    });
  });

  // Hands-free preparation is empty. Capture the exact current user entry, not
  // model-written instructions or a transcript summary. The terminating result
  // hands durable admission to the idle owner after settlement.
  function registerForegroundTool() {
  pi.registerTool({ name: "background", label: "Continue in Background", description: "Move the exact current user request into Background with no rewritten prompt or preparation. Foreground remains available. Background can refuse, narrow or explicitly rejoin.", parameters: Type.Object({}),
    async execute(toolCallId, _params, _signal, _update, ctx) {
      if (!host || pendingCurrent) throw new Error("Background unavailable");
      const branch = ctx.sessionManager.getBranch();
      const user = [...branch].reverse().find((e) => e.type === "message" && e.message.role === "user");
      if (!user || user.type !== "message") throw new Error("No current user entry");
      pendingCurrent = { content: structuredClone(user.message.content), userId: user.id, projectId: "current", admissionId: `tool-${toolCallId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0,100)}` };
      return { content: [{ type: "text", text: "Background admission requested for the exact current user entry; runtime receipt follows settlement." }], details: {}, terminate: true };
    },
  });
  }
  pi.on("agent_settled", () => {
    if (!pendingCurrent) return;
    const pending = pendingCurrent;
    pendingCurrent = undefined;
    setImmediate(() => {
      try {
        if (!host || host.closed) return;
        const current = snapshot();
        host.admit({ admissionId: pending.admissionId, parentSessionId: current.sessionId, parentLeafId: current.leafId, projectId: pending.projectId, content: pending.content }, pending.userId);
        publish();
      } catch { fail(); }
    });
  });
  pi.on("session_shutdown", async () => {
    clearInterval(rejoinTimer);
    stopping.abort();
    if (subscription) await subscription;
    const outcome = host ? await host.shutdown() : { quarantined: [] };
    host = undefined;
    // An uncertain writer keeps its kernel lease until process death. Reload
    // must fail closed rather than birth a second owner over the same archives.
    if (outcome.quarantined.length === 0) await lease?.release();
    lease = undefined;
    context = undefined;
  });
}
