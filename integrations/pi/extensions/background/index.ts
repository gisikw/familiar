import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BackgroundHost } from "../../../../packages/background/host.mjs";
import { acquireHostLease } from "../../../../packages/background/lease.mjs";
import {
  id,
  report,
  reportData,
} from "../../../../packages/background/protocol.mjs";
import { createBranchRuntime } from "./runtime.ts";
import { createChildBackend } from "./backend.ts";
import { ChildSubscription } from "../../../../packages/background/subscription.mjs";

export default function background(pi: ExtensionAPI) {
  pi.registerEntryRenderer("familiar.background-dispatch", (entry) => {
    const receipt = entry.data as any;
    try {
      if (
        receipt?.version !== 2 ||
        receipt?.provenance !== "runtime-control" ||
        Object.keys(receipt).length !== 5
      )
        throw new Error("invalid receipt");
      id(receipt.admissionId);
      id(receipt.branchSessionId);
      return new Text(
        `Background workstream ${id(receipt.workstreamId)} admitted; admission did not start a foreground reply.`,
        0,
        0,
      );
    } catch {
      return new Text("Invalid Background receipt", 0, 0);
    }
  });
  pi.registerMessageRenderer(
    "familiar.background.merge",
    (message, options) => {
      try {
        if (
          typeof message.content !== "string" ||
          Buffer.byteLength(message.content) > 40 * 1024
        )
          throw new Error("invalid packet");
        const packet = JSON.parse(message.content);
        if (
          packet.type !== "familiar.background.merge" ||
          packet.version !== 2 ||
          packet.provenance !== "broker-merge"
        )
          throw new Error("invalid packet");
        const data = report(reportData(packet));
        const lines = [
          `Background ${data.disposition}: ${options.expanded ? data.summary : data.summary.slice(0, 512)}`,
        ];
        if (options.expanded) {
          for (const field of [
            "decisions",
            "durableContext",
            "risks",
            "questions",
            "changedArtifacts",
          ])
            if (data[field].length)
              lines.push(`${field}: ${data[field].join("; ")}`);
        } else if (data.questions.length)
          lines.push(`Questions: ${data.questions.join("; ")}`);
        return new Text(lines.join("\n"), 0, 0);
      } catch {
        return new Text("Invalid Background merge packet", 0, 0);
      }
    },
  );
  let host: BackgroundHost | undefined;
  let lease: Awaited<ReturnType<typeof acquireHostLease>> | undefined;
  let context: ExtensionContext | undefined;
  let subscription: ChildSubscription | undefined;
  let rejoinTimer: ReturnType<typeof setInterval> | undefined;
  const client = createChildBackend();
  let pendingCurrent:
    | {
        content: unknown;
        userId: string;
        projectId: string;
        admissionId: string;
      }
    | undefined;
  const snapshot = (options?: { context?: boolean }) => {
    lease?.assertOwned();
    if (!context) throw new Error("Background owner unavailable");
    // The raw canonical branch is the audit record, not the child's context. It
    // is scanned in place (private spans, current user entry, parent/leaf fence)
    // and never copied into a branch archive, so its size is not a child-context
    // budget: a long-lived compacted session keeps a branch far larger than any
    // context Pi would send. Only the effective context the host derives is
    // bounded, by the host, against LIMITS.contextBytes. The owner commits its
    // admission by appending a tiny batch to this branch, O(batch), so the
    // parent's size is never an admission refusal either.
    const entries = context.sessionManager.getBranch();
    let privateSpan = false;
    for (const entry of entries) {
      if (
        entry.type === "custom" &&
        entry.customType === "familiar-ui/transcript-visibility"
      )
        privateSpan = (entry.data as any)?.visibility !== "public";
    }
    return {
      sessionId: context.sessionManager.getSessionId(),
      leafId: context.sessionManager.getLeafId(),
      file: context.sessionManager.getSessionFile(),
      model: context.model
        ? { provider: context.model.provider, id: context.model.id }
        : undefined,
      // Pi exposes the effective, already model-clamped level on the live
      // context. Capture it in the same synchronous admission snapshot as the
      // model; never consult the foreground again while constructing a branch.
      thinkingLevel: context.thinkingLevel,
      cwd: context.cwd,
      idle: context.isIdle() && (pi as any).isRuntimeControlAvailable(),
      private: privateSpan,
      entries,
      messages: options?.context
        ? buildSessionContext(entries, context.sessionManager.getLeafId())
            .messages
        : [],
    };
  };
  const publish = () => {
    if (!context) return;
    try {
      pi.events.emit("familiar:background:changed", {});
    } catch {
      /* retired extension instance */
    }
  };
  const fail = () => {
    context?.ui.notify(
      "Background operation requires inspection; no automatic replay",
      "warning",
    );
    publish();
  };

  pi.on("session_start", async (_event, ctx) => {
    if (
      ctx.mode !== "tui" ||
      host ||
      process.env.FAMILIAR_BACKGROUND_ENABLE !== "1"
    )
      return;
    if (typeof (pi as any).commitRuntimeControl !== "function") return;
    context = ctx;
    const state = process.env.FAMILIAR_BACKGROUND_STATE_DIR;
    // No ambient fallback: the Familiar launcher must supply a private host root.
    if (!state) return;
    mkdirSync(state, { recursive: true, mode: 0o700 });
    lease = await acquireHostLease(state);
    const providerPath =
      process.env.FAMILIAR_BACKGROUND_PROVIDER_EXTENSION ??
      fileURLToPath(new URL("../tiamat/index.ts", import.meta.url));
    try {
      host = new BackgroundHost({
        root: state,
        owner: {
          modelRequired: true,
          available: () => (pi as any).isRuntimeControlAvailable(),
          snapshot,
          commit: (
            sessionId: string,
            leafId: string | null,
            entries: any[],
          ) => {
            lease!.assertOwned();
            const ids = (pi as any).commitRuntimeControl(
              sessionId,
              leafId,
              entries,
            );
            publish();
            return ids;
          },
        },
        createRuntime: (record: any, owner: any) =>
          createBranchRuntime(record, owner, providerPath, client),
        onError: fail,
        onChange: publish,
      });
    } catch (error) {
      await lease.release();
      lease = undefined;
      context = undefined;
      throw error;
    }
    subscription = new ChildSubscription(host.store, host.scheduler, client, {
      onChange: publish,
    });
    subscription.start();
    rejoinTimer = setInterval(() => {
      try {
        host?.flushRejoins();
      } catch {
        fail();
      }
    }, 250);
    rejoinTimer.unref?.();
    registerForegroundTool();
    publish();
  });

  // In-process capability discovery only. The browser cannot provide callbacks
  // or invoke pi commands: its bridge constructs this envelope after validation.
  pi.events.on("familiar:background:discover", (value: any) => {
    if (!host || host.closed) return;
    value.accept({
      admit: (request: any) => {
        const receipt = host!.admit(request);
        publish();
        return receipt;
      },
      list: () =>
        host!.store
          .publicList(context!.sessionManager.getSessionId())
          .map((r: any) => ({
            ...r,
            backend: client.resourceStatus(),
          })),
      control: async (request: any) => {
        const h = host!;
        if (request.action === "cancel")
          h.cancel(request.workstreamId, request.generation);
        else if (request.action === "release")
          await h.reconcileAndRelease(
            request.workstreamId,
            request.generation,
            client,
          );
        else if (request.action === "steer")
          h.steer(
            request.workstreamId,
            request.generation,
            request.commandId,
            request.text,
          );
        else if (request.action === "rejoin")
          h.rejoin(
            request.workstreamId,
            request.generation,
            request.packetId,
            request.expectedLeafId,
          );
        else if (
          ["answer-child", "steer-child", "cancel-child"].includes(
            request.action,
          )
        ) {
          const children = h.scheduler.lane(
            request.workstreamId,
            request.generation,
          ).runtime.children;
          children.owned(request.jobId);
          if (request.action === "answer-child")
            await children.answer(
              request.jobId,
              request.questionId,
              request.commandId,
              request.text,
            );
          if (request.action === "steer-child")
            await children.steer(
              request.jobId,
              request.commandId,
              request.text,
            );
          if (request.action === "cancel-child")
            await children.cancel(request.jobId);
        } else throw new Error("unknown Background action");
        publish();
      },
    });
  });

  // If the model selects Background in a parallel tool batch, preparation
  // siblings must not run or force an automatic foreground continuation.
  pi.on("tool_call", (event, ctx) => {
    if (!host || event.toolName === "background") return;
    const leaf = ctx.sessionManager.getLeafEntry();
    if (
      leaf?.type === "message" &&
      leaf.message.role === "assistant" &&
      leaf.message.content.some(
        (part) => part.type === "toolCall" && part.name === "background",
      )
    )
      return {
        block: true,
        terminate: true,
        reason:
          "Background admission owns this batch; sibling preparation tools are not run.",
      };
  });

  // Hands-free preparation is empty. Capture the exact current user entry, not
  // model-written instructions or a transcript summary. The terminating result
  // hands durable admission to the idle owner after settlement.
  function registerForegroundTool() {
    pi.registerTool({
      name: "background",
      label: "Continue in Background",
      description:
        "Move the exact current user request into Background with no rewritten prompt or preparation. Foreground remains available. Background can refuse, narrow or explicitly rejoin.",
      promptSnippet:
        "Delegate the exact current user entry without preparation",
      promptGuidelines: [
        "Call background directly and on its own; do not prepare a replacement prompt or run preparation tools.",
      ],
      parameters: Type.Object({}),
      async execute(toolCallId, _params, _signal, _update, ctx) {
        if (!host || pendingCurrent) throw new Error("Background unavailable");
        const branch = ctx.sessionManager.getBranch();
        const user = [...branch]
          .reverse()
          .find((e) => e.type === "message" && e.message.role === "user");
        if (!user || user.type !== "message")
          throw new Error("No current user entry");
        pendingCurrent = {
          content: structuredClone(user.message.content),
          userId: user.id,
          projectId: "current",
          admissionId: `tool-${toolCallId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100)}`,
        };
        return {
          content: [
            {
              type: "text",
              text: "Background admission requested for the exact current user entry; runtime receipt follows settlement.",
            },
          ],
          details: {},
          terminate: true,
        };
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
        host.admit(
          {
            admissionId: pending.admissionId,
            parentSessionId: current.sessionId,
            parentLeafId: current.leafId,
            projectId: pending.projectId,
            content: pending.content,
          },
          pending.userId,
        );
        publish();
      } catch {
        fail();
      }
    });
  });
  pi.on("session_shutdown", async () => {
    clearInterval(rejoinTimer);
    await subscription?.stop();
    const outcome = host ? await host.shutdown() : { quarantined: [] };
    host = undefined;
    // An uncertain writer keeps its kernel lease until process death. Reload
    // must fail closed rather than birth a second owner over the same archives.
    if (outcome.quarantined.length === 0) await lease?.release();
    lease = undefined;
    context = undefined;
  });
}
