import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dirname, join } from "node:path";
import { OwnedChildren } from "../../../../packages/background/children.mjs";
import { GolemClient } from "../../../../contrib/familiar/pi/agents/api.ts";

const text = Type.String({ maxLength: 32768 });
const strings = Type.Optional(Type.Array(Type.String({ maxLength: 2048 }), { maxItems: 32 }));
const result = (value: unknown, terminate = false) => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 32768) throw new Error("Owned tool output exceeds 32 KiB; inspect a narrower artifact/status");
  return { content: [{ type: "text" as const, text }], details: {}, terminate };
};

export async function createBranchRuntime(record: any, host: any, model: any, providerPath: string, client: GolemClient) {
  const root = dirname(record.archive.file);
  const children = new OwnedChildren(host.store, record.id, record.generation, client);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    additionalExtensionPaths: [providerPath],
    systemPromptOverride: () => "You are an independent Background workstream. Continue the exact last user request using the admitted context. You own your Golem dispatches, questions, answers, reviews and integration. Do not claim foreground assent. Use background_report to finish, refuse, narrow scope or return. These controls are always available. No recursive Background fork exists. Child events are local; explicitly report questions only when you need foreground help.",
    extensionFactories: [{ name: "background-controls", factory: (pi) => {
      pi.registerTool({ name: "background_report", label: "Report / refuse / rejoin", description: "Durably report progress, refuse, narrow or return to foreground. Terminal requestedRejoin packets are delivered after full settlement, never by assistant assent.",
        parameters: Type.Object({ reportId: Type.String(), disposition: Type.String({ enum: ["progress", "blocked", "ready", "failed", "refused", "narrowed", "returned"] }), summary: Type.String({ maxLength: 8192 }), requestedRejoin: Type.Boolean(), decisions: strings, durableContext: strings, risks: strings, questions: strings, changedArtifacts: strings, integrationRef: Type.Optional(Type.String({ maxLength: 2048 })) }),
        async execute(_id, packet) { return result(host.report(record.id, record.generation, packet), packet.requestedRejoin); },
      });
      pi.registerTool({ name: "agents_dispatch", label: "Dispatch owned Golem", description: "Dispatch a child Golem owned exclusively by this branch. Use agents_capabilities for existing harness/model/workspace semantics.",
        parameters: Type.Object({ key: Type.String(), harness: Type.String(), model: Type.String(), workspace: Type.Union([Type.Object({ project: Type.String(), worktree: Type.String() }), Type.Object({ repo: Type.String(), ref: Type.Optional(Type.String()), worktree: Type.String() })]), prompt: text }),
        async execute(_id, { key, ...request }) { return result(await children.dispatch(key, request)); },
      });
      pi.registerTool({ name: "agents_capabilities", label: "Golem capabilities", description: "Read configured Golem harnesses, models and projects.", parameters: Type.Object({}), async execute() { return result(await client.capabilities()); } });
      pi.registerTool({ name: "agents_owned", label: "Owned Golem controls", description: "Inspect, answer blocked questions, steer, cancel, review settlement or inspect artifact references for a branch-owned child. Review requires the exact pending event sequence. Retry work uses the existing Golem steer semantics; dispatch retries reuse their key.",
        parameters: Type.Object({ jobId: Type.String(), action: Type.String({ enum: ["status", "answer", "steer", "cancel", "review", "artifacts"] }), questionId: Type.Optional(Type.String()), key: Type.Optional(Type.String()), text: Type.Optional(text), seq: Type.Optional(Type.Integer()) }),
        async execute(_id, p) {
          children.owned(p.jobId);
          if (p.action === "answer") return result(await children.answer(p.jobId, p.questionId, p.key, p.text));
          if (p.action === "steer") return result(await client.steer(p.jobId, p.text!));
          if (p.action === "cancel") return result(await children.cancel(p.jobId));
          if (p.action === "artifacts") return result(await children.artifacts(p.jobId));
          if (p.action === "review") { children.acknowledgeEvent(p.jobId, p.seq); return result({ reviewed: true }); }
          return result({ job: await children.status(p.jobId), reviewSeq: children.owned(p.jobId).pendingEvent?.seq ?? null });
        },
      });
    } }],
  });
  await loader.reload();
  const manager = SessionManager.open(record.archive.file);
  (manager as any).setPersistenceBudget(32 * 1024 * 1024);
  const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader: loader, modelRuntime, sessionManager: manager, noTools: "builtin" });
  await session.bindExtensions({ mode: "print" });
  const available = modelRuntime.getModel(model.provider, model.id);
  if (!available) { session.dispose(); throw new Error("branch model unavailable"); }
  await session.setModel(available);
  session.setThinkingLevel("off");
  // Explicit tool allowlist plus no ambient extensions: recursive tools cannot
  // be re-enabled, while report/refusal remains in the configured registry.
  session.setActiveToolsByName(["background_report", "agents_dispatch", "agents_capabilities", "agents_owned"]);
  let first = true;
  let aborting: Promise<void> | undefined;
  return {
    sessionId: record.archive.sessionId, file: record.archive.file, session, children,
    async run(content?: string) {
      if (first) { first = false; await (session as any).continueAdmittedTurn(); }
      else await session.prompt(content!, { expandPromptTemplates: false });
      if (session.messages.at(-1)?.stopReason === "error") throw new Error("branch inference failed");
    },
    abort() {
      return aborting ??= (async () => {
        await session.abort();
        // Use durable create keys to resolve uncertain creates before cancelling;
        // the generation has already been fenced by the scheduler.
        for (const child of host.store.get(record.id).children) {
          const jobId = child.jobId ?? (await client.dispatch({ ...child.request, idempotency_key: child.createKey })).id;
          await client.cancel(jobId);
          for (;;) {
            const job = await client.status(jobId);
            if (["done", "failed", "cancelled", "timeout"].includes(job.state) && job.settlement) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      })();
    },
    dispose() { session.dispose(); },
  };
}
