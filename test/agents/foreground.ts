// Test-only commands around the real owner and its fixed Imp Agent handler.
// No production transport, ledger, reconciliation, or operation is replaced.
import agents from "../../integrations/pi/extensions/agents/index.ts";
import imp from "../../integrations/pi/extensions/imp/index.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const slot = Symbol.for("familiar.imp.agent.v1");
export default function (pi: ExtensionAPI) {
  agents(pi);
  imp(pi);
  const root = process.env.FA_PROOF_ROOT!;
  const execute = (operation: string, args: unknown) => {
    const handler = (process as any)[slot];
    if (!handler) throw new Error("Agent Imp handler unavailable");
    return handler.handle({ version: 1, area: "agent", operation, args });
  };
  pi.registerCommand("proof-dispatch", {
    handler: async () => {
      const request = JSON.parse(readFileSync(join(root, "request.json"), "utf8"));
      request.machine = request.machine_id;
      delete request.machine_id;
      if (request.options?.thinking) request.thinking = request.options.thinking;
      delete request.options;
      await execute("dispatch", request);
    },
  });
  pi.registerCommand("proof-answer", {
    handler: async () => {
      const status: any = await execute("status", {});
      await execute("answer", { id: status.jobs[0].job_id, key: "answer", text: "yes" });
    },
  });
  pi.registerCommand("proof-reconcile", {
    handler: async () => { await execute("reconcile", {}); },
  });
  pi.registerCommand("proof-ping", {
    handler: async (_args, ctx) => {
      writeFileSync(join(root, "foreground-ping"), String(Date.now()));
      ctx.ui.notify("foreground responsive", "info");
    },
  });
  pi.registerCommand("proof-stop", { handler: async (_args, ctx) => ctx.shutdown() });
}
