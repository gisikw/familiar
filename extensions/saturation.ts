import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Saturation warnings: rising-edge reminders at 5% bucket boundaries once
// context passes the warn threshold.
//
// Saturation is computed against an artificial cap (FAMILIAR_MAX_CONTEXT,
// default 200k) rather than the model's real context window: big-window
// models would otherwise let sessions balloon, and smaller sessions are
// worth keeping anyway. The real window still applies if it is smaller.
//
// Injections ride before_agent_start as appended messages — prefix cache
// unaffected. Rising-edge only: each bucket fires once per session, and a
// fresh session (post-/clear) starts with a clean slate.

const BUCKET_SIZE = 5;

export default function(pi: ExtensionAPI) {
  const cap = Number(process.env.FAMILIAR_MAX_CONTEXT) || 200_000;
  const warn = Number(process.env.FAMILIAR_SATURATION_WARN) || 50;
  const critical = Number(process.env.FAMILIAR_SATURATION_CRITICAL) || 80;
  let lastBucket = 0;

  pi.on("before_agent_start", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (usage?.tokens == null) return;

    const limit = usage.contextWindow > 0 ? Math.min(cap, usage.contextWindow) : cap;
    const percent = (usage.tokens / limit) * 100;
    const bucket = Math.floor(percent / BUCKET_SIZE) * BUCKET_SIZE;
    if (percent < warn || bucket <= lastBucket) return;
    lastBucket = bucket;

    const advice =
      percent >= critical
        ? "Context is getting full. Wrap up current work and use the clear tool — the handoff will carry open threads forward."
        : percent >= critical - 10
          ? "Context is filling up. Start wrapping up — finish the current task, note open threads."
          : "Context is past halfway. Be mindful of scope — avoid starting large new tasks.";

    return {
      message: {
        customType: "saturation",
        content: `<system-reminder>Context window saturation: ${Math.trunc(percent)}%. ${advice}</system-reminder>`,
        display: false,
      },
    };
  });
}
