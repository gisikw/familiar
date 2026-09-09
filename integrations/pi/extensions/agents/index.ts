import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { homedir } from "node:os";
import { Ledger } from "./ledger.mjs";
import { Owner } from "./owner.mjs";
import { configuration, Transport } from "./transport.mjs";
import { projection, privateSpanActive } from "./contract.mjs";
import {
  ensureDirs,
  enqueueEnvelopeIdempotent,
  withdrawEnvelopeIdempotent,
  worklistPaths,
} from "../worklist/store.ts";

/** Explicit CLI capability, not an inherited environment flag. Only run_pi passes
 * it. Background SDK sessions and child Pi processes do not start an owner. */
export default function (pi: ExtensionAPI) {
  pi.registerFlag("familiar-agents-owner", {
    description: "Own the foreground Familiar Agents reconciler",
    type: "boolean",
    default: false,
  });
  let owner: Owner | undefined;
  let provenance = "";
  let context:
    | import("@earendil-works/pi-coding-agent").ExtensionContext
    | undefined;
  const projectionKey = Symbol.for("familiar.agents.projection.v1");
  let source: { read: () => unknown } | undefined;
  const current = () => {
    if (context && privateSpanActive(context.sessionManager.getBranch()))
      throw new Error(
        "Familiar Agents is unavailable inside /private; explicitly declassify work first",
      );
    if (!owner)
      throw new Error(
        "Familiar Agents unavailable: foreground owner/configuration required; no local fallback",
      );
    owner.guard();
    return owner;
  };
  const result = (details: unknown) => {
    const bytes = Buffer.from(JSON.stringify(details));
    const text =
      bytes.length <= 48000
        ? bytes.toString("utf8")
        : bytes.subarray(0, 48000).toString("utf8") +
          "\n[Output truncated at 48 KB; page status or inspect one machine/job. Full bounded details remain in the ledger/tool record.]";
    return { content: [{ type: "text" as const, text }], details };
  };
  const str = (maxLength = 256) => Type.String({ minLength: 1, maxLength });
  pi.on("session_start", (_event, ctx) => {
    if (
      ctx.mode !== "tui" ||
      pi.getFlag("familiar-agents-owner") !== true ||
      owner
    )
      return;
    provenance = ctx.sessionManager.getSessionId();
    context = ctx;
    try {
      const config = configuration(process.env.FAMILIAR_AGENTS_CONFIG);
      const root =
        process.env.FAMILIAR_AGENTS_STATE_DIR ||
        join(
          process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
          "familiar",
          "agents",
        );
      const worklist =
        process.env.FAMILIAR_WORKLIST_DIR || process.env.FAMILIAR_INBOX_DIR;
      if (!worklist)
        throw new Error("explicit Familiar worklist root required");
      const paths = worklistPaths(worklist);
      ensureDirs(paths);
      owner = new Owner(
        new Ledger(join(root, "agents.sqlite3")),
        new Transport(config, join(root, "transport")),
        async (envelope) => {
          // Same official store implementation as worklist. Synchronous durable
          // acceptance avoids loader-isolated capability registries and network
          // work under foreground dispatch gates. Worklist owns all delivery.
          if (envelope.withdraw) withdrawEnvelopeIdempotent(paths, envelope);
          else enqueueEnvelopeIdempotent(paths, envelope);
          return true;
        },
        { idleGraceMs: config.idle_grace_ms },
      );
      owner.changed = () => pi.events.emit("familiar:agents-changed", {});
      owner.start(); // Schedules network work; startup never awaits reconciliation.
      const installed = owner;
      source = {
        read: () => {
          installed.guard();
          return {
            available: true,
            jobs: [
              ...new Map(
                [
                  ...installed.ledger
                    .active()
                    .filter(
                      (j) =>
                        !["settled", "abandoned", "failed_admission"].includes(
                          j.semantic_state,
                        ),
                    ),
                  ...installed.ledger.list(32),
                ].map((j) => [j.job_id, j]),
              ).values(),
            ]
              .slice(0, 32)
              .map((j) => ({
                job_id: j.job_id,
                label: j.label,
                machine_id: j.machine_id,
                semantic_state: j.semantic_state,
                reachability: j.reachability,
                verdict:
                  j.settlement_verdict ??
                  (j.settlement_json
                    ? JSON.parse(j.settlement_json).verdict
                    : null),
                observation: j.observation ?? null,
                summary: j.settlement_json
                  ? JSON.parse(j.settlement_json).summary.slice(0, 2048)
                  : (j.blocked_context ?? j.last_error ?? "").slice(0, 2048) ||
                    null,
                attach_hint: projection(j).attach_hint,
                owner_session: j.owner_session.slice(0, 128),
                updated_at: j.updated_at,
              })),
          };
        },
      };
      (process as any)[projectionKey] = source;
      owner.changed();
    } catch {
      owner = undefined;
      ctx.ui.notify(
        "Familiar Agents unavailable: check explicit enrollment/configuration. No local fallback.",
        "warning",
      );
    }
  });
  pi.on("session_shutdown", async () => {
    if ((process as any)[projectionKey] === source)
      delete (process as any)[projectionKey];
    const old = owner;
    owner = undefined;
    await old?.stop();
  });
  pi.registerTool({
    name: "familiar_agents_capabilities",
    label: "Familiar Agents Enrollment",
    description:
      "List explicitly enrolled machine IDs, or exact Pi model choices on one machine. No credentials or native route configuration are returned.",
    parameters: Type.Object(
      { machine_id: Type.Optional(str(48)) },
      { additionalProperties: false },
    ),
    execute: async (_id, p) => {
      const t = current().transport;
      if (p.machine_id) {
        const m = t.enrolled(p.machine_id);
        return result({
          machine_id: m.name,
          harnesses: ["pi"],
          models: m.models,
          profile_mode: m.profile_mode,
        });
      }
      return result({
        machines: t.config.machines.map((m) => ({
          machine_id: m.name,
          model_count: m.models.length,
        })),
        authority:
          "arbitrary shell at the enrolled account effective authority; not a sandbox",
      });
    },
  });
  pi.registerTool({
    name: "familiar_agents_dispatch",
    label: "Dispatch Familiar Agent",
    description:
      "Admit durable work on an explicitly enrolled Drover machine. Pi foreground in a visible Herdr space; arbitrary authority of the enrolled account, no sandbox. repo is an absolute repository path on that machine. Returns admission, not completion.",
    parameters: Type.Object(
      {
        key: str(),
        machine_id: str(48),
        harness: str(32),
        model: str(),
        repo: str(4096),
        requested_ref: str(),
        task: str(24576),
        label: str(80),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, p) => result(current().dispatch(p, provenance)),
  });
  pi.registerTool({
    name: "familiar_agents_status",
    label: "Familiar Agent Status",
    description:
      "Read the Familiar ledger, including unresolved idle and unknown reachability. Bounded page of five; inspection is not acknowledgment or settlement.",
    parameters: Type.Object(
      {
        id: Type.Optional(str()),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, p) => {
      const o = current();
      if (p.id) {
        const j = o.ledger.get(p.id);
        if (!j) throw new Error("unknown job");
        return result(projection(j));
      }
      const jobs = o.ledger.list(5, p.offset || 0).map((j) => ({
        job_id: j.job_id,
        label: j.label,
        machine_id: j.machine_id,
        semantic_state: j.semantic_state,
        reachability: j.reachability,
        summary: j.settlement_json
          ? JSON.parse(j.settlement_json).summary.slice(0, 1024)
          : j.last_error,
        updated_at: j.updated_at,
      }));
      return result({ total: o.ledger.count(), jobs });
    },
  });
  for (const kind of ["steer", "answer", "cancel"] as const)
    pi.registerTool({
      name: `familiar_agents_${kind}`,
      label: `Familiar Agent ${kind}`,
      description:
        "Persist ordered intent. Offline delivery waits; uncertain delivery is not replayed. Cancellation is not semantic settlement.",
      parameters: Type.Object(
        {
          id: str(),
          key: str(),
          text: Type.Optional(str(8192)),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, p) =>
        result(
          current().intent(
            p.id,
            kind,
            p.text || "",
            p.key,
            `exo:${provenance}`,
          ),
        ),
    });
  pi.registerTool({
    name: "familiar_agents_reconcile",
    label: "Retry Familiar Reconciliation",
    description:
      "Schedule immediate reconciliation, never blindly replay uncertain mutations.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      current().kick();
      return result({ scheduled: true });
    },
  });
  pi.registerCommand("familiar-agents", {
    description: "Familiar Agents ledger snapshot (no network wait)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        JSON.stringify(
          current()
            .ledger.list(5)
            .map((j) => ({
              job_id: j.job_id,
              label: j.label,
              state: j.semantic_state,
              reachability: j.reachability,
            })),
          null,
          2,
        ),
        "info",
      );
    },
  });
  pi.registerCommand("familiar-agent-resolve-operation", {
    description:
      "After native inspection: <id> <workspace|launch|prompt> <retry-confirmed-absent|prompt-confirmed-delivered> <reason>",
    handler: async (args, ctx) => {
      const [id, operation, resolution, ...reason] = args.trim().split(/\s+/);
      ctx.ui.notify(
        JSON.stringify(
          current().resolveOperation(
            id,
            operation,
            resolution,
            reason.join(" "),
            `operator-command:${provenance}`,
          ),
        ),
        "info",
      );
    },
  });
  pi.registerCommand("familiar-agent-cleanup", {
    description:
      "Queue explicit retained remote workspace cleanup after retention: <job-id>. Dirty worktrees are never force-removed.",
    handler: async (args, ctx) => {
      ctx.ui.notify(
        JSON.stringify(
          current().queueCleanup(args.trim(), `operator-command:${provenance}`),
        ),
        "info",
      );
    },
  });
  pi.registerCommand("familiar-agent-settle", {
    description:
      "Operator settlement (not agent proof): <id> <done|failed|cancelled> <summary>",
    handler: async (args, ctx) => {
      const [id, verdict, ...summary] = args.trim().split(/\s+/);
      ctx.ui.notify(
        JSON.stringify(
          current().operatorSettle(
            id,
            verdict,
            summary.join(" "),
            `operator-command:${provenance}`,
          ),
        ),
        "info",
      );
    },
  });
  pi.registerCommand("familiar-agent-resolve-intent", {
    description:
      "Resolve uncertain delivery after native inspection: <id> <intent-key> <reason>. New delivery requires a new key.",
    handler: async (args, ctx) => {
      const [id, key, ...reason] = args.trim().split(/\s+/);
      ctx.ui.notify(
        JSON.stringify(
          current().resolveIntent(
            id,
            key,
            reason.join(" "),
            `operator-command:${provenance}`,
          ),
        ),
        "info",
      );
    },
  });
  pi.registerCommand("familiar-agent-abandon", {
    description:
      "Explicitly abandon unresolved work: <job-id> <reason>. Does not kill/delete the remote workspace.",
    handler: async (args, ctx) => {
      const [id, ...reason] = args.trim().split(/\s+/);
      if (!id || !reason.length)
        throw new Error("usage: /familiar-agent-abandon <id> <reason>");
      const r = current().abandon(
        id,
        reason.join(" "),
        `operator-command:${provenance}`,
      );
      ctx.ui.notify(JSON.stringify(r), "info");
    },
  });
}
