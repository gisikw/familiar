// Credential- and SDK-independent acceptance accounting. HTTP response headers
// are deliberately not evidence of inference: providers can stream errors in 200s.
export class ProbeProgress {
  constructor(count = 3) {
    this.states = Array.from({ length: count }, () => ({
      deltas: 0, ended: false, failed: false,
    }));
  }

  observe(index, event) {
    const state = this.states[index];
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "error") state.failed = true;
      if (update?.type === "text_delta" && update.delta?.length > 0)
        state.deltas++;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      state.ended = true;
      if (!["stop", "length"].includes(event.message.stopReason))
        state.failed = true;
    }
  }

  assertHealthy() {
    if (this.states.some((state) => state.failed))
      throw new Error("provider stream failed");
  }

  branchesActive() {
    this.assertHealthy();
    return this.states.slice(1).every((state) => state.deltas > 0 && !state.ended);
  }
}

// Discover only models exposed by the configured runtime/adapter. Never fall
// back to an unrelated account or a built-in catalog model without credentials.
export async function discoverProbeModel(runtime, provider, preferredId) {
  const available = await runtime.getAvailable(provider, { signal: AbortSignal.timeout(15000) });
  const candidates = available.filter((model) => model.provider === provider);
  const selected = candidates.find((model) => model.id === preferredId) ?? candidates[0];
  if (!selected) throw new Error("no available model on authorized provider");
  return selected;
}
