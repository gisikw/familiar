import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatLocalTime, humanizeDuration } from "./lib/time.ts";

// Time awareness: reorient the model to the clock when it has gone stale.
//
// The gap is measured since the last *time awareness* (session start or 
// previous injection), not since the last message — a conversation with a 
// message every 25 minutes would otherwise suppress time reorientation indefinitely.
//
// Injections ride before_agent_start as appended messages, so the prefix
// cache is unaffected. No turn is ever proactively triggered; a stale clock
// waits for the next natural turn.

const THRESHOLD_MS = 30 * 60 * 1000;

export default function(pi: ExtensionAPI) {
  // 0 = never oriented: the very first turn always gets the current time
  // (fresh-time), then the 30-minute staleness cycle takes over.
  let lastAwareness = 0;
  let lastActivity = Date.now();

  pi.on("input", async () => {
    lastActivity = Date.now();
  });

  pi.on("before_agent_start", async () => {
    const now = Date.now();
    if (now - lastAwareness < THRESHOLD_MS) return;

    const idleGap = now - lastActivity;
    lastAwareness = now;
    lastActivity = now;

    const gapNote =
      idleGap >= THRESHOLD_MS
        ? `It's been ${humanizeDuration(idleGap)} since the last message in this conversation. `
        : "";

    return {
      message: {
        customType: "time-awareness",
        content: `<system-reminder>${gapNote}The current time is ${formatLocalTime()}.</system-reminder>`,
        display: false,
      },
    };
  });
}
