import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorLog } from "../lib/debug.ts";
import { RelayHub, NoopAudio, RelayClient } from "./relay.ts";
import { Firehose } from "./firehose.ts";
import { PendingEchoes } from "./echo.ts";
import { contextSaturation } from "./saturation.ts";

// Subscriber: thin relay between pi and the standalone familiar server
// (localhost:1692), which now owns all HTTP. The firehose still turns pi
// events into stream events; RelayHub POSTs each to the server's /ingest, and
// RelayClient subscribes to the server's /relay command bus to enact
// submit/cancel against the pi API. Protocol + event shapes live in the server
// (./protocol.ts re-exports them). Public behavior toward pi is unchanged.

export default function(pi: ExtensionAPI) {
  const hub = new RelayHub();
  const audio = new NoopAudio();
  const echoes = new PendingEchoes();
  const firehose = new Firehose(hub, audio, echoes);
  const client = new RelayClient(pi, echoes);
  let agentActive = false;
  let agentAfterMessageId: number | undefined;
  let agentHeartbeat: ReturnType<typeof setInterval> | undefined;

  // Handler bodies are wrapped: an egress bug must cost a log line, never pi.
  const guard = (fn: () => void) => {
    try { fn(); } catch (err) { errorLog("subscriber", { handlerError: String(err) }); }
  };

  pi.on("session_start", async (_event, ctx) => {
    // On pi's startup path: a throw here would abort session start outright.
    guard(() => {
      client.ctx = ctx;
      hub.announceSession();
      const saturation = contextSaturation(ctx);
      if (saturation !== undefined) firehose.onSaturation(saturation);
      client.start();
      // A failed transition POST remains queued, and this periodic assertion
      // both retries that queue and repairs gateway state after any bounded
      // relay loss. Clients can independently poll the gateway's /agent
      // snapshot, so a missed settled edge cannot strand them as busy.
      if (agentHeartbeat) clearInterval(agentHeartbeat);
      agentHeartbeat = setInterval(() => hub.publish({
        event: "agent", active: agentActive,
        ...(agentActive ? { after_message_id: agentAfterMessageId } : {}),
      }), 10_000);
    });
  });
  pi.on("session_shutdown", async () => { guard(() => {
    if (agentHeartbeat) clearInterval(agentHeartbeat);
    agentHeartbeat = undefined;
    agentActive = false;
    agentAfterMessageId = undefined;
    hub.publish({ event: "agent", active: false });
    client.close();
  }); });

  pi.on("agent_start", async () => guard(() => {
    agentActive = true;
    agentAfterMessageId = firehose.cursor;
    hub.publish({
      event: "agent", active: true, after_message_id: agentAfterMessageId,
    });
  }));
  // Unlike message_end/turn_end, agent_settled is after Pi has completed any
  // tool continuation, retry, or compaction loop. This is turn completion.
  pi.on("agent_settled", async () => guard(() => {
    agentActive = false;
    agentAfterMessageId = undefined;
    hub.publish({ event: "agent", active: false });
  }));

  pi.on("message_start", async (event) => guard(() => firehose.onMessageStart(event.message)));
  pi.on("message_update", async (event) => guard(() => firehose.onMessageUpdate(event.message, event.assistantMessageEvent)));
  pi.on("message_end", async (event) => guard(() => firehose.onMessageEnd(event.message)));
  // turn_end runs after Pi has committed the assistant usage. Its
  // getContextUsage() value is therefore the authoritative latest-after-turn
  // context, including compaction semantics and trailing messages.
  pi.on("turn_end", async (event, ctx) => guard(() => {
    const saturation = contextSaturation(ctx, event.message);
    if (saturation !== undefined) firehose.onSaturation(saturation);
  }));
  pi.on("agent_end", async () => guard(() => firehose.onAgentEnd()));
  pi.on("tool_execution_start", async (event) => guard(() => firehose.onToolStart(event.toolCallId, event.toolName, event.args)));
}
