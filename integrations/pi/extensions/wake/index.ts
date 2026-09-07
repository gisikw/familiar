import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { formatLocalTime } from "../lib/time.ts";
import { WakeRuntime } from "./runtime.ts";

// wake: the resident agent's durable alarm clock. Records live outside Pi's
// session transcript so /reload, /new, Presence respawn, and host reboot do not
// erase them. Delivery remains in the one interactive Pi process: this
// extension only arms timers and calls sendMessage from that process.
function stateRoot(): string {
  if (process.env.FAMILIAR_WAKE_DIR) return path.resolve(process.env.FAMILIAR_WAKE_DIR);
  if (process.env.FAMILIAR_PRESENCE_STATE_DIR) {
    return path.join(path.resolve(process.env.FAMILIAR_PRESENCE_STATE_DIR), "wakes");
  }
  if (process.env.PI_CODING_AGENT_DIR) {
    return path.join(path.resolve(process.env.PI_CODING_AGENT_DIR), "wakes");
  }
  return path.resolve(".familiar-wakes");
}

export default function (pi: ExtensionAPI) {
  const runtime = new WakeRuntime(pi, stateRoot());

  // input catches direct browser/TUI/worklist user ingress; agent_start catches
  // custom worklist settlements that trigger a turn. The scheduling turn's
  // agent_start precedes the wake tool call and therefore cannot cancel itself.
  const noteFreshInput = () => {
    try { runtime.freshInput(); } catch { /* durability retries on next event/start */ }
  };
  pi.on("input", async () => noteFreshInput());
  pi.on("agent_start", async () => noteFreshInput());

  pi.on("session_start", async (_event, ctx) => {
    try { runtime.start(); }
    catch { ctx.ui.notify("wake: durable state unavailable; alarms not restored", "error"); }
  });
  pi.on("session_shutdown", async () => {
    // Timers are session-scoped resources, records are not. The replacement
    // extension restores them during its next session_start.
    runtime.stop();
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
    promptGuidelines: [
      "Use wake (normally mode unless_wakened) when something needs checking later and no settlement or worklist event will fire; never run blocking sleeps in the live conversation.",
    ],
    parameters: Type.Object({
      duration_minutes: Type.Number({
        description: "How long from now the wake should fire, in minutes",
        minimum: 0.1,
      }),
      mode: StringEnum(["unless_wakened", "always"] as const, {
        description:
          "'unless_wakened': cancel if fresh user/worklist/settlement activity arrives first. " +
          "'always': fire regardless of intervening activity.",
      }),
      reason: Type.String({
        description: "Why you scheduled this wake; echoed back so future-you can orient",
        maxLength: 16_384,
      }),
    }),
    async execute(_toolCallId, params) {
      const milliseconds = Math.max(6_000, Math.round(params.duration_minutes * 60_000));
      const wake = runtime.schedule(params.mode, params.reason, milliseconds);
      const note = params.mode === "unless_wakened"
        ? "will be cancelled if fresh activity arrives first"
        : "will fire regardless of intervening activity";
      return {
        content: [{
          type: "text",
          text:
            `Wake ${wake.id} durably scheduled for ${formatLocalTime(new Date(wake.fireAt))} ` +
            `(${params.mode}: ${note}). End the turn normally; do not wait or poll.`,
        }],
        details: wake,
      };
    },
  });
}
