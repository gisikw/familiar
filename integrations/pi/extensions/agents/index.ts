import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";

// Thin transport bridge to the independently deployable Familiar Agent System.
// familiar.toml's [agents] endpoint is flattened by familiar-config.sh to the
// same FAMILIAR_AGENTS_ENDPOINT consumed by the CLI and this extension.
const CLI = process.env.FAMILIAR_AGENTS_CLI || "familiar-agents";
const ENDPOINT = process.env.FAMILIAR_AGENTS_ENDPOINT || "http://127.0.0.1:7337";
const DEFAULT_HOST = process.env.FAMILIAR_AGENTS_HOST;
const MAX_OUTPUT = 2 * 1024 * 1024;

type ToolResult = {
  content: { type: "text"; text: string }[];
  details?: unknown;
  isError?: boolean;
};

const invoke = (args: string[], signal?: AbortSignal): Promise<ToolResult> =>
  new Promise((resolve) => {
    execFile(
      CLI,
      ["--service", ENDPOINT, "--json", ...args],
      { encoding: "utf8", maxBuffer: MAX_OUTPUT, signal },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || error.message).trim();
          resolve({
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
            details: { ok: false, error: message },
            isError: true,
          });
          return;
        }
        try {
          const value = JSON.parse(stdout);
          resolve({
            content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
            details: value,
          });
        } catch {
          resolve({
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "familiar-agents returned invalid JSON" }) }],
            isError: true,
          });
        }
      },
    );
  });

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "agents_dispatch",
    label: "Dispatch Agent",
    description: "Dispatch bounded work to the external Familiar Agent System. Returns the durable job record immediately.",
    promptSnippet: "Dispatch async work to an independently supervised agent worker",
    parameters: Type.Object({
      prompt: Type.String({ description: "Complete task description; the worker starts cold" }),
      host: Type.Optional(Type.String({ description: "Worker host (defaults to FAMILIAR_AGENTS_HOST)" })),
      harness: Type.Optional(Type.String({ description: "Harness: pi, claude, codex, or fake (default pi)" })),
      model: Type.Optional(Type.String({ description: "Harness model override" })),
      cwd: Type.Optional(Type.String({ description: "Worker directory (default current directory)" })),
      worktree: Type.Optional(Type.Boolean({ description: "Request detached git-worktree isolation" })),
      key: Type.Optional(Type.String({ description: "Creation idempotency key" })),
    }),
    async execute(_id, p: { prompt: string; host?: string; harness?: string; model?: string; cwd?: string; worktree?: boolean; key?: string }, signal) {
      const host = p.host || DEFAULT_HOST;
      if (!host) return invoke(["dispatch", "--host", "", p.prompt], signal);
      const args = ["dispatch", "--host", host];
      if (p.harness) args.push("--harness", p.harness);
      if (p.model) args.push("--model", p.model);
      if (p.cwd) args.push("--cwd", p.cwd);
      if (p.worktree) args.push("--worktree");
      if (p.key) args.push("--key", p.key);
      args.push(p.prompt);
      return invoke(args, signal);
    },
  });

  pi.registerTool({
    name: "agents_status",
    label: "Agent Status",
    description: "Inspect one delegated job, or list jobs. This does not block.",
    promptSnippet: "Inspect delegated-agent lifecycle state",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Job id; omit to list jobs" })),
      state: Type.Optional(Type.String({ description: "Lifecycle filter when listing" })),
    }),
    async execute(_id, p: { id?: string; state?: string }, signal) {
      return p.id
        ? invoke(["status", p.id], signal)
        : invoke(["list", ...(p.state ? ["--state", p.state] : [])], signal);
    },
  });

  pi.registerTool({
    name: "agents_await",
    label: "Await Agent",
    description: "Block without polling in the conversation until a job settles or asks a blocked question. Timeout does not cancel it.",
    promptSnippet: "Join a delegated job and return its durable status or settlement",
    parameters: Type.Object({
      id: Type.String({ description: "Job id" }),
      timeout: Type.Optional(Type.Integer({ description: "Maximum seconds to wait (default 600)" })),
    }),
    async execute(_id, p: { id: string; timeout?: number }, signal) {
      return invoke(["await", "--timeout", `${p.timeout ?? 600}s`, p.id], signal);
    },
  });

  pi.registerTool({
    name: "agents_respond",
    label: "Respond to Agent",
    description: "Answer the currently blocked question for a delegated job.",
    promptSnippet: "Answer a blocked delegated agent",
    parameters: Type.Object({
      id: Type.String({ description: "Job id" }),
      text: Type.String({ description: "Answer text" }),
    }),
    async execute(_id, p: { id: string; text: string }, signal) {
      return invoke(["answer", p.id, p.text], signal);
    },
  });

  pi.registerTool({
    name: "agents_cancel",
    label: "Cancel Agent",
    description: "Request durable cancellation of a delegated job.",
    promptSnippet: "Cancel a delegated agent job",
    parameters: Type.Object({ id: Type.String({ description: "Job id" }) }),
    async execute(_id, p: { id: string }, signal) {
      return invoke(["cancel", p.id], signal);
    },
  });
}
