import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { OwnedChildren } from "../../../../packages/background/children.mjs";
import { configureBranchSession } from "../../../../packages/background/runtime-config.mjs";
import type { BackgroundChildBackend } from "./backend.ts";

const text = Type.String({ maxLength: 32768 });
const strings = Type.Optional(
  Type.Array(Type.String({ maxLength: 2048 }), { maxItems: 32 }),
);
const result = (value: unknown, terminate = false) => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 32768)
    throw new Error(
      "Owned tool output exceeds 32 KiB; inspect a narrower artifact/status",
    );
  return { content: [{ type: "text" as const, text }], details: {}, terminate };
};

export async function createBranchRuntime(
  record: any,
  host: any,
  providerPath: string,
  client: BackgroundChildBackend,
) {
  const root = dirname(record.archive.file);
  const children = new OwnedChildren(
    host.store,
    record.id,
    record.generation,
    client,
  );
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
    modelsStorePath: join(root, "models-store.json"),
    allowModelNetwork: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    additionalExtensionPaths: [providerPath],
    systemPromptOverride: () =>
      "You are an independent Background workstream. Continue the exact last user request using the admitted context. You own your Golem dispatches, questions, answers, reviews and integration. Do not claim foreground assent. Use background_report to finish, refuse, narrow scope or return. These controls are always available. No recursive Background fork exists. Child events are local; explicitly report questions only when you need foreground help.",
    extensionFactories: [
      {
        name: "background-controls",
        factory: (pi) => {
          pi.registerTool({
            name: "background_report",
            label: "Report / refuse / rejoin",
            description:
              "Durably report progress, refuse, narrow or return to foreground. Terminal requestedRejoin packets are delivered after full settlement, never by assistant assent.",
            parameters: Type.Object({
              reportId: Type.String(),
              disposition: Type.String({
                enum: [
                  "progress",
                  "blocked",
                  "ready",
                  "failed",
                  "refused",
                  "narrowed",
                  "returned",
                ],
              }),
              summary: Type.String({ maxLength: 8192 }),
              requestedRejoin: Type.Boolean(),
              decisions: strings,
              durableContext: strings,
              risks: strings,
              questions: strings,
              changedArtifacts: strings,
              integrationRef: Type.Optional(Type.String({ maxLength: 2048 })),
            }),
            async execute(_id, packet) {
              return result(
                host.report(record.id, record.generation, packet),
                packet.requestedRejoin,
              );
            },
          });
          pi.registerTool({
            name: "agents_dispatch",
            label: "Dispatch owned Golem",
            description:
              "Dispatch a child Golem owned exclusively by this branch. Use agents_capabilities for existing harness/model/workspace semantics.",
            parameters: Type.Object({
              key: Type.String(),
              harness: Type.String(),
              model: Type.String(),
              workspace: Type.Union([
                Type.Object({
                  project: Type.String(),
                  worktree: Type.String(),
                }),
                Type.Object({
                  repo: Type.String(),
                  ref: Type.Optional(Type.String()),
                  worktree: Type.String(),
                }),
              ]),
              prompt: text,
            }),
            async execute(_id, { key, ...request }) {
              const job = await children.dispatch(key, request);
              host.onChange();
              return result(job);
            },
          });
          pi.registerTool({
            name: "agents_capabilities",
            label: "Golem capabilities",
            description:
              "Read configured Golem harnesses, models and projects.",
            parameters: Type.Object({}),
            async execute() {
              return result(await client.capabilities());
            },
          });
          pi.registerTool({
            name: "agents_owned",
            label: "Owned Golem controls",
            description:
              "Inspect, answer blocked questions, steer, cancel, review settlement or read artifacts for a branch-owned child. Artifact text is paged in 4 KiB chunks; backend responses are capped at 4 MiB. Review requires the exact pending event sequence. Steer running jobs using backend semantics. Retrying a dispatch reuses its key; new work after settlement needs a new explicitly owned dispatch.",
            parameters: Type.Object({
              jobId: Type.String(),
              action: Type.String({
                enum: [
                  "status",
                  "answer",
                  "steer",
                  "cancel",
                  "review",
                  "artifacts",
                  "artifact",
                ],
              }),
              questionId: Type.Optional(Type.String()),
              key: Type.Optional(Type.String()),
              text: Type.Optional(text),
              seq: Type.Optional(Type.Integer()),
              path: Type.Optional(Type.String({ maxLength: 1024 })),
              offset: Type.Optional(
                Type.Integer({ minimum: 0, maximum: 4 * 1024 * 1024 }),
              ),
            }),
            async execute(_id, p) {
              children.owned(p.jobId);
              if (p.action === "answer")
                return result(
                  await children.answer(p.jobId, p.questionId, p.key, p.text),
                );
              if (p.action === "steer")
                return result(
                  await children.steer(
                    p.jobId,
                    p.key ?? createHash("sha256").update(_id).digest("hex"),
                    p.text,
                  ),
                );
              if (p.action === "cancel")
                return result(await children.cancel(p.jobId));
              if (p.action === "artifacts")
                return result(await children.artifacts(p.jobId));
              if (p.action === "artifact") {
                if (!p.path) throw new Error("artifact path required");
                const bytes = Buffer.from(
                  await children.fetchArtifact(p.jobId, p.path),
                );
                const offset = p.offset ?? 0;
                return result({
                  path: p.path,
                  offset,
                  bytes: bytes.length,
                  text: bytes.subarray(offset, offset + 4096).toString("utf8"),
                  nextOffset:
                    offset + 4096 < bytes.length ? offset + 4096 : null,
                });
              }
              if (p.action === "review") {
                children.acknowledgeEvent(p.jobId, p.seq);
                return result({ reviewed: true });
              }
              const job = await children.status(p.jobId);
              host.onChange();
              return result({
                job,
                reviewSeq: children.owned(p.jobId).pendingEvent?.seq ?? null,
              });
            },
          });
        },
      },
    ],
  });
  await loader.reload();
  const manager = SessionManager.open(record.archive.file);
  (manager as any).setPersistenceBudget(32 * 1024 * 1024);
  const { session } = await createAgentSession({
    cwd: manager.getCwd(),
    agentDir: root,
    settingsManager,
    resourceLoader: loader,
    modelRuntime,
    sessionManager: manager,
    tools: [
      "read",
      "grep",
      "find",
      "ls",
      "background_report",
      "agents_dispatch",
      "agents_capabilities",
      "agents_owned",
    ],
  });
  const disposeSession = async () => {
    try {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
    } finally {
      session.dispose();
    }
  };
  try {
    await session.bindExtensions({ mode: "print" });
    await configureBranchSession(session, modelRuntime, record);
    // Explicit tool allowlist plus no ambient extensions: recursive tools cannot
    // be re-enabled, while report/refusal remains in the configured registry.
    session.setActiveToolsByName([
      "read",
      "grep",
      "find",
      "ls",
      "background_report",
      "agents_dispatch",
      "agents_capabilities",
      "agents_owned",
    ]);
  } catch (error) {
    await disposeSession();
    throw error;
  }
  let first = true;
  let aborting: Promise<void> | undefined;
  let disposing: Promise<void> | undefined;
  return {
    sessionId: record.archive.sessionId,
    file: record.archive.file,
    session,
    children,
    async run(content?: string) {
      if (first) {
        first = false;
        await (session as any).continueAdmittedTurn();
      } else await session.prompt(content!, { expandPromptTemplates: false });
      if (session.messages.at(-1)?.stopReason === "error")
        throw new Error("branch inference failed");
      const current = host.store.get(record.id);
      const last = session.messages.at(-1);
      if (
        current.generation === record.generation &&
        current.status === "running" &&
        last?.role === "assistant" &&
        last.stopReason === "stop" &&
        current.packets.at(-1)?.run !== current.run &&
        !current.children.some(
          (child: any) =>
            !child.terminal || child.questionId || child.pendingEvent,
        )
      ) {
        // A plain refusal/return must not silently linger forever. Do not infer
        // approval or fabricate decisions: return a bounded, explicitly unverified
        // fragment of this one final message, never the branch transcript.
        const text = last.content
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join("\n");
        const bytes = Buffer.from(text);
        host.report(record.id, record.generation, {
          reportId: `runtime-return-${record.generation}-${current.run}`,
          disposition: "returned",
          requestedRejoin: true,
          summary: `Unstructured branch return (not an integration approval):\n${bytes.subarray(0, 4096).toString("utf8")}${bytes.length > 4096 ? "\n[truncated]" : ""}`,
          risks: [
            "No structured report was provided; no integration claims were validated.",
          ],
          decisions: [],
          durableContext: [],
          questions: [],
          changedArtifacts: [],
        });
      }
    },
    abort() {
      return (aborting ??= (async () => {
        await session.abort();
        // Read-only lookup of uncertain creates; never dispatch new work during
        // abort. Absence is uncertain and retains the reservation/quarantine.
        for (const child of host.store.get(record.id).children) {
          if (child.terminal) continue;
          const jobId =
            child.jobId ?? (await client.lookupCreate(child.createKey))?.id;
          if (!jobId)
            throw new Error(
              "Child creation outcome unresolved; backend reconciliation required",
            );
          await client.cancel(jobId);
          for (;;) {
            const job = await client.status(jobId);
            if (
              ["done", "failed", "cancelled", "timeout"].includes(job.state) &&
              job.settlement
            ) {
              const current = host.store.get(record.id);
              host.store.update(
                record.id,
                current.generation,
                "child-retired",
                (r: any) => {
                  const owned = r.children.find(
                    (c: any) => c.key === child.key,
                  );
                  owned.jobId = jobId;
                  owned.terminal = true;
                  owned.questionId = null;
                  owned.pendingEvent = null;
                },
              );
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      })());
    },
    async verifyStopped() {
      await session.abort();
      return (
        session.isIdle &&
        !session.isStreaming &&
        host.store.get(record.id).children.every((child: any) => child.terminal)
      );
    },
    dispose() {
      return (disposing ??= disposeSession());
    },
  };
}
