// Test-only driver around the real extension factory. No production transport,
// ledger, reconciliation, or tool execution is replaced by this wrapper.
import main from "../../integrations/pi/extensions/agents/index.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const tools = new Map<string, any>();
  main(
    new Proxy(pi, {
      get(target, key) {
        if (key === "registerTool")
          return (definition: any) => {
            tools.set(definition.name, definition);
            pi.registerTool(definition);
          };
        return Reflect.get(target, key);
      },
    }),
  );
  const root = process.env.FA_PROOF_ROOT!;
  const execute = (name: string, params: unknown, ctx: unknown) =>
    tools
      .get(name)
      .execute("isolated-proof", params, undefined, undefined, ctx);
  pi.registerCommand("proof-dispatch", {
    handler: async (_args, ctx) => {
      await execute(
        "familiar_agents_dispatch",
        JSON.parse(readFileSync(join(root, "request.json"), "utf8")),
        ctx,
      );
    },
  });
  pi.registerCommand("proof-answer", {
    handler: async (_args, ctx) => {
      const status = await execute("familiar_agents_status", {}, ctx);
      await execute(
        "familiar_agents_answer",
        { id: status.details.jobs[0].job_id, key: "answer", text: "yes" },
        ctx,
      );
    },
  });
  pi.registerCommand("proof-reconcile", {
    handler: async (_args, ctx) => {
      await execute("familiar_agents_reconcile", {}, ctx);
    },
  });
  pi.registerCommand("proof-ping", {
    handler: async (_args, ctx) => {
      writeFileSync(join(root, "foreground-ping"), String(Date.now()));
      ctx.ui.notify("foreground responsive", "info");
    },
  });
  pi.registerCommand("proof-stop", {
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });
}
