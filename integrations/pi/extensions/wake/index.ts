import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { formatLocalTime, humanizeDuration } from "../lib/time.ts";

// wake: the agent's interruptible (or uninterruptible) alarm clock.
//
// Gives the presence agent a way to end its turn normally and still get
// woken at a chosen future time — for deploy convergence checks, settling
// infrastructure, or anything else with no event that would otherwise fire.
// This exists so the agent never needs a blocking sleep in the live channel.
//
// The mode is a required parameter by design (agentic UX): the caller must
// state, on every call, whether the wake is
//   - "unless_wakened": skipped if any fresh message (user, settlement,
//     worklist) has arrived since it was scheduled — an interruptible nap; or
//   - "always": fires regardless of intervening activity — a hard alarm.
// Requiring the choice reinforces the behavioral contract each time.
//
// Wakes are in-memory only: /reload, /new, or process exit clears them.
// The wake fires as a custom message (deliverAs: "followUp"), so it never
// interrupts a running turn — it waits for the agent to be idle, then
// triggers one.
//
// Deliberate exception to the worklist convention ("senders enqueue, never
// sendMessage"): a wake is a self-scheduled alarm whose contract is temporal
// precision. Routing it through attention tiers/digests could delay or
// suppress an "always" wake, breaking the contract. The live channel is
// protected instead by unless_wakened (skips if the session was already
// wakened) and by followUp delivery (never preempts a running turn).

export default function (pi: ExtensionAPI) {
  let counter = 0;
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  // "Wakened" means any activity that started a turn or delivered input:
  // user messages fire `input`; settlements/worklist deliveries trigger
  // turns and therefore fire `agent_start`. The scheduling turn's own
  // agent_start predates the tool call, so a wake never cancels itself.
  let lastWakenedAt = 0;

  pi.on("input", async () => {
    lastWakenedAt = Date.now();
  });

  pi.on("agent_start", async () => {
    lastWakenedAt = Date.now();
  });

  pi.on("session_shutdown", async () => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  });

  pi.registerTool({
    name: "wake",
    label: "Wake",
    description:
      "Schedule a future wake for yourself, then end the turn normally. " +
      "After duration_minutes, a wake message arrives and triggers a turn. " +
      "mode 'unless_wakened' skips the wake if any fresh message (user, " +
      "settlement, worklist) arrived after scheduling — an interruptible " +
      "nap. mode 'always' fires regardless. Wakes do not survive /reload " +
      "or session switches. Never use blocking sleeps in the live channel; " +
      "use this instead.",
    promptSnippet:
      "Schedule a future self-wake instead of ever blocking on sleep",
    promptGuidelines: [
      "Use wake (mode unless_wakened) when something needs checking later and no settlement or worklist event will fire; never run blocking sleeps in the live conversation.",
    ],
    parameters: Type.Object({
      duration_minutes: Type.Number({
        description: "How long from now the wake should fire, in minutes",
        minimum: 0.1,
      }),
      mode: StringEnum(["unless_wakened", "always"] as const, {
        description:
          "'unless_wakened': skip if any fresh message arrives first. " +
          "'always': fire regardless of intervening activity.",
      }),
      reason: Type.String({
        description:
          "Why you scheduled this wake; echoed back in the wake message so future-you can orient",
      }),
    }),
    async execute(_toolCallId, params) {
      const ms = Math.max(6_000, Math.round(params.duration_minutes * 60_000));
      const id = ++counter;
      const scheduledAt = Date.now();
      const fireAt = new Date(scheduledAt + ms);

      const timer = setTimeout(() => {
        pending.delete(id);
        if (params.mode === "unless_wakened" && lastWakenedAt > scheduledAt) {
          return; // Something else woke the session first; nap not needed.
        }
        pi.sendMessage(
          {
            customType: "wake",
            content:
              `<system-reminder>Scheduled wake #${id} firing (mode: ${params.mode}), ` +
              `set ${humanizeDuration(ms)} ago at ${formatLocalTime(new Date(scheduledAt))}. ` +
              `Reason: ${params.reason}</system-reminder>`,
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      }, ms);
      pending.set(id, timer);

      const skipNote =
        params.mode === "unless_wakened"
          ? "will be skipped if any fresh message arrives first"
          : "will fire regardless of intervening activity";
      return {
        content: [
          {
            type: "text",
            text:
              `Wake #${id} scheduled for ${formatLocalTime(fireAt)} ` +
              `(${params.mode}: ${skipNote}). End the turn normally; ` +
              `do not wait or poll.`,
          },
        ],
        details: {
          id,
          mode: params.mode,
          reason: params.reason,
          scheduledAt,
          fireAt: fireAt.getTime(),
        },
      };
    },
  });
}
