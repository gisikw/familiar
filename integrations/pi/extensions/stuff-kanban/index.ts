import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadBoard, moveItem, type StuffExec, type StuffItem } from "./stuff.ts";
import { openKanban } from "./ui.ts";

export const DEFAULT_BATCH_ID = "item_uy26qlk42ra4xtkeih2skgtjwa";

async function openInBrowser(pi: ExtensionAPI, item: StuffItem, cwd: string): Promise<void> {
  const base = (process.env.STUFF_URL || "http://127.0.0.1:7847").replace(/\/$/, "");
  const url = `${base}/read/items/${encodeURIComponent(item.id)}`;
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const result = await pi.exec(command, [url], { timeout: 10_000, cwd });
  if (result.code !== 0) {
    const detail = result.stderr.trim().replace(/\s+/g, " ").slice(0, 240);
    throw new Error(detail ? `Could not open ${url}: ${detail}` : `Could not open ${url}`);
  }
}

export default function stuffKanban(pi: ExtensionAPI): void {
  pi.registerCommand("stuff-kanban", {
    description: "Open a four-lane board for a Stuff batch",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("stuff-kanban requires Pi's interactive TUI", "error");
        return;
      }

      const batchId = args.trim() || process.env.STUFF_KANBAN_BATCH?.trim() || DEFAULT_BATCH_ID;
      try {
        const exec: StuffExec = (command, commandArgs) =>
          pi.exec(command, commandArgs, { timeout: 15_000, cwd: ctx.cwd });
        const board = await loadBoard(batchId, { exec });
        await openKanban(ctx, board, {
          move: (item, lane) => moveItem(exec, item, lane),
          open: (item) => openInBrowser(pi, item, ctx.cwd),
        });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
