import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { formatLocalTime } from "../lib/time.ts";
import { WakeClient } from "./store.ts";

// familiar-services owns wake persistence and timers. Due wakes arrive through
// the ordinary worklist, preserving its DND and pacing policy.
export default function (pi: ExtensionAPI) {
  const client = new WakeClient();
  const noteFreshActivity = async (at = Date.now()) => {
    try { await client.freshActivity(at); }
    catch { /* Worklist/service calls surface availability; retry on next activity. */ }
  };
  // The service cancels interruptible wakes when work is enqueued. Direct user
  // and Pi activity is bridged here because M2 has no wake.fresh-input op.
  pi.on("input", async () => noteFreshActivity());
  pi.on("agent_start", async () => noteFreshActivity());
  pi.events.on("familiar:fresh-input", (event: unknown) => {
    const at = (event as { at?: unknown })?.at;
    void noteFreshActivity(typeof at === "number" ? at : Date.now());
  });

  pi.registerTool({
    name: "wake",
    label: "Wake",
    description:
      "Durably schedule a future wake for yourself, then end the turn normally. " +
      "After duration_minutes, a wake message arrives and triggers a turn, including after /reload, " +
      "session switch, Presence respawn, or host reboot. mode 'unless_wakened' cancels durably if any " +
      "fresh user, settlement, or worklist activity arrives after scheduling; mode 'always' fires " +
      "regardless. Never use blocking sleeps in the live channel; use this instead.",
    promptSnippet: "Durably schedule a future self-wake instead of ever blocking on sleep",
    promptGuidelines: ["Use wake (normally mode unless_wakened) when something needs checking later and no settlement or worklist event will fire; never run blocking sleeps in the live conversation."],
    parameters: Type.Object({
      duration_minutes: Type.Number({ description: "How long from now the wake should fire, in minutes", minimum: 0.1 }),
      mode: StringEnum(["unless_wakened", "always"] as const, { description: "'unless_wakened': cancel if fresh user/worklist/settlement activity arrives first. 'always': fire regardless of intervening activity." }),
      reason: Type.String({ description: "Why you scheduled this wake; echoed back so future-you can orient", maxLength: 16_384 }),
    }),
    async execute(_toolCallId, params) {
      const durationMinutes = Math.max(0.1, params.duration_minutes);
      const wake = await client.schedule(params.mode, params.reason, durationMinutes);
      const note = params.mode === "unless_wakened" ? "will be cancelled if fresh activity arrives first" : "will fire regardless of intervening activity";
      return { content: [{ type: "text", text: `Wake ${wake.id} durably scheduled for ${formatLocalTime(new Date(wake.fireAt))} (${params.mode}: ${note}). End the turn normally; do not wait or poll.` }], details: wake };
    },
  });
}
