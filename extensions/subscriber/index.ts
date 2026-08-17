import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorLog } from "../lib/debug.ts";
import { SubscriberManager } from "./server.ts";
import { Firehose } from "./firehose.ts";

// Subscriber: voice/text ingress + SSE egress for remote clients (Hearth).
// Protocol documentation and event shapes live in ./protocol.ts;
// modules: hub (SSE clients/history), audio (synthesis cache), firehose
// (pi events → stream events), server (HTTP + ingress).

export default function(pi: ExtensionAPI) {
  const manager = new SubscriberManager(pi);
  const firehose = new Firehose(manager.hub, manager.audio, manager.echoes);

  // Handler bodies are wrapped: an egress bug must cost a log line, never pi.
  const guard = (fn: () => void) => {
    try { fn(); } catch (err) { errorLog("subscriber", { handlerError: String(err) }); }
  };

  pi.on("session_start", async (_event, ctx) => {
    manager.start(Number(process.env.FAMILIAR_SUBSCRIBER_PORT ?? 1692));
    manager.ctx = ctx;
  });
  pi.on("session_shutdown", async () => { manager.close(); });

  pi.on("message_start", async (event) => guard(() => firehose.onMessageStart(event.message)));
  pi.on("message_update", async (event) => guard(() => firehose.onMessageUpdate(event.message, event.assistantMessageEvent)));
  pi.on("message_end", async (event) => guard(() => firehose.onMessageEnd(event.message)));
  pi.on("agent_end", async () => guard(() => firehose.onAgentEnd()));
  pi.on("tool_execution_start", async (event) => guard(() => firehose.onToolStart(event.toolCallId, event.toolName, event.args)));
}
