import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debugLog, errorLog } from "../lib/debug.ts";
import { planRewind, type BranchEntry } from "./rewind.ts";

/*
 * /rewind: the one /tree move Kev uses, reachable from familiar-ui. Move the
 * leaf to a checkpoint with no summary. Validation lives in rewind.ts so a
 * mid-turn or off-branch id is refused before anything moves. For a
 * user-message target Pi hands its text back to the *TUI* editor; the browser
 * restores its own composer, so clear the TUI copy rather than leave text an
 * Enter could send.
 *
 * This is all that remains of the zip extension. The mark/marks/zip tools and
 * commands were removed once forks took over the job of keeping tangents out
 * of the primary context.
 */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("rewind", {
    description: "/rewind <entryId> — move everything after a checkpoint onto an inactive branch (no summary; nothing deleted)",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const plan = planRewind(ctx.sessionManager.getBranch() as unknown as BranchEntry[], args);
      if (!plan.ok) {
        ctx.ui.notify(plan.error, "warning");
        return;
      }
      try {
        // The label is load-bearing: branch() only moves the in-memory leaf, and
        // Pi re-derives the leaf from the last entry on reopen. Pi appends a
        // label entry on the new branch, so a restart before the next message
        // still lands here instead of snapping back to the abandoned branch.
        const result = await ctx.navigateTree(plan.targetId, { summarize: false, label: "rewind" });
        if (result.cancelled) {
          ctx.ui.notify("Rewind cancelled", "warning");
          return;
        }
        if (plan.editorText && ctx.hasUI && ctx.ui.getEditorText().trim() === plan.editorText.trim()) ctx.ui.setEditorText("");
        debugLog("rewind", { event: "rewind", target: plan.targetId, kind: plan.kind, dropped: plan.dropped });
        ctx.ui.notify(`Rewound: ${plan.dropped} ${plan.dropped === 1 ? "entry" : "entries"} moved to an inactive branch (still in the session file)`, "info");
      } catch (error) {
        errorLog("rewind", { event: "rewind", error: error instanceof Error ? error.message : String(error) });
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
