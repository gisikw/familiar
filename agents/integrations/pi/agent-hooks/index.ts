/**
 * Familiar agent-hooks — the pi "hook adapter" for the Familiar agent system.
 *
 * Loaded into an interactive worker's pi instance with `--extension`. Because an
 * interactive TUI has no JSON stdout lifecycle stream, this extension reports
 * lifecycle out-of-band: it appends durable records to the side-channel path
 * named by FAMILIAR_AGENTS_EVENTS. The Go pi adapter (agents/harnesses/pi)
 * advances a durable byte cursor over that file to project lifecycle and build
 * the settlement.
 *
 * Happy path: agent_start -> "running"/"progress" -> agent_settled -> "settled".
 * The settlement carries the final assistant message (verdict text) and usage
 * from the preceding agent_end, when the pi API exposes them.
 *
 * Blocked-question detection: pi 0.84.x exposes no first-class "awaiting
 * operator input" event to extensions. The side-channel schema reserves a
 * "blocked" record but nothing emits it yet — a documented stub.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendEvent, finalAssistant, settledEvent, type AssistantLike } from "./events.ts";

export default function (pi: ExtensionAPI) {
  const path = process.env.FAMILIAR_AGENTS_EVENTS;
  if (!path) {
    // Not launched by the agent supervisor: do nothing rather than spam.
    return;
  }

  const emit = (event: Parameters<typeof appendEvent>[1]) => {
    try {
      appendEvent(path, event);
    } catch (err) {
      // The side channel is best-effort telemetry; a write failure must not
      // crash the worker's interactive session. The supervisor's process/exit
      // observation remains the crash boundary.
      try {
        process.stderr.write(`[agent-hooks] side-channel write failed: ${String(err)}\n`);
      } catch {
        /* ignore */
      }
    }
  };

  // Stash the last agent_end payload so agent_settled (which carries no data)
  // can emit the final assistant message + usage.
  let lastFinal: AssistantLike | undefined;

  pi.on("agent_start", async () => {
    emit({ type: "running", ts: Date.now() });
  });

  pi.on("turn_end", async (event) => {
    const turn = (event as { turnIndex?: number }).turnIndex;
    emit({ type: "progress", ts: Date.now(), ...(typeof turn === "number" ? { turn } : {}) });
  });

  pi.on("agent_end", async (event) => {
    const messages = (event as { messages?: unknown[] }).messages ?? [];
    lastFinal = finalAssistant(messages);
  });

  pi.on("agent_settled", async () => {
    emit(settledEvent(lastFinal, Date.now(), "done"));
    lastFinal = undefined;
  });
}
