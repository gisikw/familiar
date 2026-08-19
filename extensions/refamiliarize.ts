import { mkdirSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const requestPath = process.env.FAMILIAR_RELOAD_REQUEST_PATH;
const completePath = process.env.FAMILIAR_RELOAD_COMPLETE_PATH;

const requestReload = (ctx: ExtensionContext): string | undefined => {
  if (!requestPath) return "FAMILIAR_RELOAD_REQUEST_PATH is not set";
  mkdirSync(dirname(requestPath), { recursive: true });
  writeFileSync(requestPath, `${new Date().toISOString()}\n`, "utf-8");
  ctx.shutdown();
  return undefined;
};

export default function refamiliarizeExtension(pi: ExtensionAPI) {
  pi.registerCommand("refamiliarize", {
    description: "Restart the complete Familiar Herdr environment and resume this session",
    handler: async (_args, ctx) => {
      const error = requestReload(ctx);
      if (error) ctx.ui.notify(error, "error");
      else ctx.ui.notify("Refamiliarization requested; restarting after Pi settles", "info");
    },
  });

  pi.registerTool({
    name: "refamiliarize",
    label: "Refamiliarize",
    description: "Gracefully stop Pi, restart the complete Familiar Herdr environment, resume this session, and continue with a Reload complete user message.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const error = requestReload(ctx);
      if (error) throw new Error(error);
      return {
        content: [{ type: "text", text: "Refamiliarization requested. Pi will shut down after this turn settles, then Familiar will restart and resume the session." }],
        details: {},
      };
    },
  });

  pi.on("session_start", async () => {
    if (!completePath || !existsSync(completePath)) return;
    setTimeout(() => {
      try {
        pi.sendUserMessage("Reload complete");
        unlinkSync(completePath);
      } catch {
        // Keep the marker so another restart can retry the completion turn.
      }
    }, 0);
  });
}
