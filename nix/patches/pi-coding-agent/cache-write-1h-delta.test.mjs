// Behavior test for cache-write-1h-delta.patch: no network, injected fetch.
// tiamat's facade (and any proxy aggregating several upstream calls) sends a
// zero-usage message_start and reports the cache_creation 5m/1h split only in
// message_delta. Pi must take cacheWrite1h from there, and price it at 1h.
// Usage: node cache-write-1h-delta.test.mjs <installed pi-monorepo root>
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
assert(root, "usage: cache-write-1h-delta.test.mjs <pi-monorepo root>");
const { stream } = await import(
  pathToFileURL(join(root, "node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js")).href
);

const sse = (events) =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const msg = (usage) => ({
  type: "message_start",
  message: { id: "msg_t", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage },
});
const body = (startUsage, deltaUsage) =>
  sse([
    ["message_start", msg(startUsage)],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: deltaUsage }],
    ["message_stop", { type: "message_stop" }],
  ]);

const model = {
  id: "m", name: "m", api: "anthropic-messages", provider: "test", baseUrl: "http://127.0.0.1:9",
  reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 1024,
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

async function run(text) {
  const fetch = async () =>
    new Response(text, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_t" } });
  const s = stream(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { apiKey: "sk-ant-api-test", fetch });
  for await (const _ of s) { /* drain */ }
  const result = await s.result();
  assert.equal(result.stopReason, "stop", `stream failed: ${result.errorMessage}`);
  return result.usage;
}

// Facade shape: split only in message_delta.
const facade = await run(
  body({ input_tokens: 0, output_tokens: 0 }, {
    input_tokens: 4, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 683,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 683 },
  }),
);
assert.equal(facade.cacheWrite, 683);
assert.equal(facade.cacheWrite1h, 683, "1h split reported in message_delta must be recorded");
assert.ok(Math.abs(facade.cost.cacheWrite - (5 * 2 * 683) / 1e6) < 1e-12, "1h writes priced at 2x input");

// Native Anthropic shape: split in message_start, delta omits it -> preserved.
const native = await run(
  body({ input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 500,
         cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 } },
       { output_tokens: 10 }),
);
assert.equal(native.cacheWrite, 500);
assert.equal(native.cacheWrite1h, 400, "message_start split must survive a delta that omits it");

console.log("cache-write-1h-delta: ok");
