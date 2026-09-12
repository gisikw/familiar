import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";
import { Ledger } from "./ledger.mjs";
import { Owner } from "./owner.mjs";
import { configuration, Transport } from "./transport.mjs";
import { LIMITS, projection, privateSpanActive, text } from "./contract.mjs";
import { IMP_AGENT_HANDLER } from "../imp/ingress.mjs";
import {
  ensureDirs,
  enqueueEnvelopeIdempotent,
  withdrawEnvelopeIdempotent,
  worklistPaths,
} from "../worklist/store.ts";

function invalid(message: string): never {
  const error = new Error(message) as Error & { code?: string };
  error.code = "invalid_request";
  throw error;
}
function object(args: unknown, allowed: string[]): Record<string, any> {
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !allowed.includes(key))
  )
    invalid("invalid or unknown operation arguments");
  return args as Record<string, any>;
}
function requiredString(args: Record<string, any>, key: string, max = 256) {
  try {
    return text(args[key], max, key);
  } catch {
    invalid(`invalid ${key}`);
  }
}
function optionalString(args: Record<string, any>, key: string, max = 256) {
  if (args[key] === undefined) return undefined;
  return requiredString(args, key, max);
}
function boundedResult(details: unknown) {
  const bytes = Buffer.from(JSON.stringify(details));
  if (bytes.length <= 48000) return details;
  return {
    truncated: true,
    message:
      "Page status or inspect one machine/job. Full report remains in the private ledger; preview is incomplete JSON text.",
    preview: bytes.subarray(0, 12000).toString("utf8"),
  };
}

/** Durable Familiar Agents owner. No model tools are registered here: the
 * model reaches these exact operations through Bash -> imp agent -> ingress. */
export default function (pi: ExtensionAPI) {
  pi.registerFlag("familiar-agents-owner", {
    description: "Own the foreground Familiar Agents reconciler",
    type: "boolean",
    default: false,
  });
  let owner: Owner | undefined;
  let agentHandler: { handle: (request: any) => Promise<unknown> } | undefined;
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
  const actor = () => `exo:${provenance}`;

  const execute = async (operation: string, rawArgs: unknown) => {
    let p: Record<string, any>;
    let result: unknown;
    switch (operation) {
      case "capabilities": {
        p = object(rawArgs, ["machine"]);
        const machine = optionalString(p, "machine", 48);
        const transport = current().transport;
        if (machine) {
          const enrolled = transport.enrolled(machine);
          result = {
            machine_id: enrolled.name,
            harnesses: ["pi"],
            models: enrolled.models,
            profile_mode: enrolled.profile_mode,
          };
        } else {
          result = {
            machines: transport.config.machines.map((m: any) => ({
              machine_id: m.name,
              model_count: m.models.length,
            })),
            authority:
              "arbitrary shell at the enrolled account effective authority; not a sandbox",
          };
        }
        break;
      }
      case "dispatch": {
        p = object(rawArgs, [
          "key",
          "machine",
          "harness",
          "model",
          "thinking",
          "repo",
          "requested_ref",
          "task",
          "label",
        ]);
        const thinking = optionalString(p, "thinking", 16);
        if (
          thinking !== undefined &&
          !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)
        )
          invalid("invalid thinking level");
        result = current().dispatch(
          {
            key: requiredString(p, "key"),
            machine_id: requiredString(p, "machine", 48),
            harness: requiredString(p, "harness", 32),
            model: requiredString(p, "model"),
            ...(thinking === undefined ? {} : { options: { thinking } }),
            repo: requiredString(p, "repo", 4096),
            requested_ref: requiredString(p, "requested_ref"),
            task: requiredString(p, "task", LIMITS.task),
            label: requiredString(p, "label", 80),
          },
          provenance,
        );
        break;
      }
      case "status": {
        p = object(rawArgs, ["id", "offset"]);
        const id = optionalString(p, "id");
        const offset = p.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0 || offset > 100000)
          invalid("offset must be an integer from 0 through 100000");
        const o = current();
        if (id) {
          const job = o.ledger.get(id);
          if (!job) throw new Error("unknown job");
          result = projection(job);
        } else {
          result = {
            total: o.ledger.count(),
            offset,
            limit: 5,
            jobs: o.ledger.list(5, offset).map((job: any) => ({
              job_id: job.job_id,
              label: job.label,
              machine_id: job.machine_id,
              semantic_state: job.semantic_state,
              reachability: job.reachability,
              summary: job.settlement_json
                ? JSON.parse(job.settlement_json).summary.slice(0, 1024)
                : job.last_error,
              updated_at: job.updated_at,
            })),
          };
        }
        break;
      }
      case "steer":
      case "answer":
      case "cancel": {
        p = object(rawArgs, ["id", "key", "text"]);
        const value = operation === "cancel" ? "" : requiredString(p, "text", 8192);
        if (operation === "cancel" && p.text !== undefined)
          invalid("cancel does not accept text");
        result = current().intent(
          requiredString(p, "id"),
          operation,
          value,
          requiredString(p, "key"),
          actor(),
        );
        break;
      }
      case "reconcile":
        object(rawArgs, []);
        current().kick();
        result = { scheduled: true };
        break;
      case "abandon":
        p = object(rawArgs, ["id", "reason"]);
        result = current().abandon(
          requiredString(p, "id"),
          requiredString(p, "reason", 4096),
          actor(),
        );
        break;
      case "settle": {
        p = object(rawArgs, ["id", "verdict", "summary"]);
        const verdict = requiredString(p, "verdict", 16);
        if (!["done", "failed", "cancelled"].includes(verdict))
          invalid("verdict must be done, failed, or cancelled");
        result = current().operatorSettle(
          requiredString(p, "id"),
          verdict,
          requiredString(p, "summary", 8192),
          actor(),
        );
        break;
      }
      case "resolve-operation": {
        p = object(rawArgs, ["id", "operation", "resolution", "reason"]);
        const kind = requiredString(p, "operation", 16);
        const resolution = requiredString(p, "resolution", 32);
        if (!["workspace", "launch", "prompt"].includes(kind))
          invalid("operation must be workspace, launch, or prompt");
        if (
          !["retry-confirmed-absent", "prompt-confirmed-delivered"].includes(resolution)
        )
          invalid("invalid operation resolution");
        result = current().resolveOperation(
          requiredString(p, "id"),
          kind,
          resolution,
          requiredString(p, "reason", 4096),
          actor(),
        );
        break;
      }
      case "resolve-intent":
        p = object(rawArgs, ["id", "key", "reason"]);
        result = current().resolveIntent(
          requiredString(p, "id"),
          requiredString(p, "key"),
          requiredString(p, "reason", 4096),
          actor(),
        );
        break;
      default:
        invalid("unknown Imp agent operation");
    }
    return boundedResult(result);
  };

  pi.on("session_start", async (_event, ctx) => {
    if (
      ctx.mode !== "tui" ||
      pi.getFlag("familiar-agents-owner") !== true ||
      owner
    )
      return;
    provenance = ctx.sessionManager.getSessionId();
    context = ctx;
    let installed: Owner | undefined;
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
      if (!worklist) throw new Error("explicit Familiar worklist root required");
      const paths = worklistPaths(worklist);
      ensureDirs(paths);
      installed = new Owner(
        new Ledger(join(root, "agents.sqlite3")),
        new Transport(config, join(root, "transport")),
        async (envelope) => {
          if (envelope.withdraw) withdrawEnvelopeIdempotent(paths, envelope);
          else enqueueEnvelopeIdempotent(paths, envelope);
          return true;
        },
        { idleGraceMs: config.idle_grace_ms },
      );
      installed.changed = () => {
        try {
          pi.events.emit("familiar:agents-changed", {});
        } catch {}
      };
      installed.start();
      owner = installed;
      agentHandler = {
        handle: (request) => execute(request.operation, request.args),
      };
      (process as any)[IMP_AGENT_HANDLER] = agentHandler;
      source = {
        read: () => {
          installed!.guard();
          return {
            available: true,
            jobs: [
              ...new Map(
                [
                  ...installed!.ledger
                    .active()
                    .filter(
                      (job) =>
                        !["settled", "abandoned", "failed_admission"].includes(
                          job.semantic_state,
                        ),
                    ),
                  ...installed!.ledger.list(32),
                ].map((job) => [job.job_id, job]),
              ).values(),
            ]
              .slice(0, 32)
              .map((job: any) => ({
                job_id: job.job_id,
                label: job.label,
                machine_id: job.machine_id,
                semantic_state: job.semantic_state,
                reachability: job.reachability,
                verdict:
                  job.settlement_verdict ??
                  (job.settlement_json
                    ? JSON.parse(job.settlement_json).verdict
                    : null),
                observation: job.observation ?? null,
                summary: job.settlement_json
                  ? JSON.parse(job.settlement_json).summary.slice(0, 2048)
                  : (job.blocked_context ?? job.last_error ?? "").slice(0, 2048) ||
                    null,
                attach_hint: projection(job).attach_hint,
                owner_session: job.owner_session.slice(0, 128),
                updated_at: job.updated_at,
              })),
          };
        },
      };
      (process as any)[projectionKey] = source;
      installed.changed();
    } catch {
      if ((process as any)[IMP_AGENT_HANDLER] === agentHandler)
        delete (process as any)[IMP_AGENT_HANDLER];
      agentHandler = undefined;
      owner = undefined;
      await installed?.stop().catch(() => {});
      context = undefined;
      ctx.ui.notify(
        "Familiar Agents unavailable: check explicit enrollment/configuration. No local fallback.",
        "warning",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    if ((process as any)[projectionKey] === source)
      delete (process as any)[projectionKey];
    source = undefined;
    if ((process as any)[IMP_AGENT_HANDLER] === agentHandler)
      delete (process as any)[IMP_AGENT_HANDLER];
    agentHandler = undefined;
    const oldOwner = owner;
    owner = undefined;
    context = undefined;
    await oldOwner?.stop();
  });

  pi.registerCommand("familiar-agents", {
    description: "Familiar Agents ledger snapshot (no network wait)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        JSON.stringify(
          current()
            .ledger.list(5)
            .map((job) => ({
              job_id: job.job_id,
              label: job.label,
              state: job.semantic_state,
              reachability: job.reachability,
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
          current().queueCleanup(
            args.trim(),
            `operator-command:${provenance}`,
          ),
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
      ctx.ui.notify(
        JSON.stringify(
          current().abandon(
            id,
            reason.join(" "),
            `operator-command:${provenance}`,
          ),
        ),
        "info",
      );
    },
  });
}
