import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createStuffCapture } from "./client.ts";

export default function stuffExtension(pi: ExtensionAPI) {
  if (process.env.FAMILIAR_USE_STUFF !== "true") return;
  let capturing = false;

  const capture = async (args: string, ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("Stuff capture requires an interactive client", "error");
      return;
    }
    if (capturing) {
      ctx.ui.notify("A Stuff capture is already open", "warning");
      return;
    }
    capturing = true;
    try {
      const title = args.trim() || await ctx.ui.input("Capture to Stuff", "Item title");
      if (!title?.trim()) return;
      const description = await ctx.ui.editor(
        "Optional Note",
        "",
      );
      if (description === undefined) return;

      const id = await createStuffCapture(
        async (command, commandArgs) => pi.exec(command, commandArgs, { timeout: 15_000 }),
        title,
        description,
      );
      ctx.ui.notify(`Captured ${id}`, "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      capturing = false;
    }
  };

  pi.registerCommand("stuff-capture", {
    description: "Quickly create a Stuff Item and optional linked Note",
    handler: capture,
  });
  pi.registerShortcut("ctrl+s", {
    description: "Capture an Item and optional Note in Stuff",
    handler: (ctx) => capture("", ctx),
  });
}
