// Standalone egress harness: drives the subscriber extension with synthetic
// pi events, no live session involved.
process.env.FAMILIAR_SUBSCRIBER_PORT = "17777";
process.env.FAMILIAR_TTS_URL = "http://localhost:17998";
process.env.FAMILIAR_STT_URL = "http://localhost:9932";
process.env.FAMILIAR_LOG_PATH = "/tmp/familiar-test-log";

import subscriber from "../extensions/subscriber/index.ts";

const handlers: Record<string, Function[]> = {};
const sent: any[] = [];
const pi: any = {
  on(event: string, handler: Function) {
    (handlers[event] ||= []).push(handler);
  },
  sendUserMessage(parts: any, opts: any) {
    sent.push({ parts, opts });
  },
};
let aborted = 0;
const ctx: any = { ui: { getEditorText: () => "", setEditorText: () => { } }, abort: () => { aborted++; } };

subscriber(pi);

async function fire(event: string, payload: any) {
  for (const h of handlers[event] ?? []) await h(payload, ctx);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assistantUpdate(text: string, type = "text_delta") {
  return {
    message: { role: "assistant" },
    assistantMessageEvent: { type, partial: { content: [{ type: "text", text }] } },
  };
}

await fire("session_start", {});
await sleep(300);

// In-process SSE listeners: one audio, one text-only.
async function attachListener(name: string, audio: boolean, lines: string[]) {
  const res = await fetch(`http://localhost:17777/stream${audio ? "?audio=1" : ""}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (frame.startsWith("data: ")) lines.push(frame.slice(6));
      }
    }
  })().catch(() => {});
}
const audioSeen: string[] = [];
const textSeen: string[] = [];
await attachListener("audio", true, audioSeen);
await attachListener("text", false, textSeen);
await sleep(200);

// --- Scene 1: plain user message ---
await fire("message_start", { message: { role: "user", content: [{ type: "text", text: "hey, what's the plan?" }] } });

// --- Scene 2: assistant turn with sentence boundaries + a code block ---
await fire("message_start", { message: { role: "assistant", content: [] } });
let t = "";
const chunks = [
  "Good question. ",              // sentence 1 (short, under min at first token... cumulative)
  "The plan is to finish the stream endpoint tonight. ",
  "Here's the config:\n\n```js\nconst x = 1;\n```\n\nAnd that",
  " covers the setup completely. ",
  "One more thing!",
];
for (const c of chunks) {
  t += c;
  await fire("message_update", assistantUpdate(t));
  await sleep(30);
}
await fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: t }] } });

// --- Scene 3: tool call ---
await fire("tool_execution_start", { toolCallId: "tc1", toolName: "bash", args: { command: "x".repeat(500) } });

// --- Scene 4: private turn (handoff) must not leak ---
await fire("message_start", { message: { customType: "handoff-request", content: "SECRET handoff prompt" } });
await fire("message_start", { message: { role: "assistant", content: [] } });
await fire("message_update", assistantUpdate("SECRET handoff body. It should never appear on the stream. "));
await fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "SECRET handoff body. It should never appear on the stream. " }] } });
await fire("agent_end", {});

// --- Scene 5: interrupted turn -> lock via agent_end, no message_end ---
await fire("message_start", { message: { role: "user", content: [{ type: "text", text: "wait, stop" }] } });
await fire("message_start", { message: { role: "assistant", content: [] } });
await fire("message_update", assistantUpdate("I was going to explain but"));
await fire("agent_end", {}); // interruption: no message_end

// --- Scene 6: failed synthesis ---
await fire("message_start", { message: { role: "assistant", content: [] } });
const failText = "This segment contains FAILME so synthesis dies. ";
await fire("message_update", assistantUpdate(failText));
await fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: failText }] } });

// --- Scene 6b: slow synthesis -> 202 (Retry-After) while pending, 200 once ready ---
await fire("message_start", { message: { role: "assistant", content: [] } });
const slowText = "This one is SLOWME so synthesis crawls. ";
await fire("message_update", assistantUpdate(slowText));
await fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: slowText }] } });
await sleep(50); // let the segment event reach the SSE buffer; well under the 400ms slow-synth delay
const slowSeg = audioSeen.map((l) => JSON.parse(l)).find((e) => e.event === "segment" && /SLOWME/.test(e.text ?? ""));
const pendingProbe = await fetch(`http://localhost:17777/segments/${slowSeg?.message_id}/0/audio`);
const pendingRetryAfter = pendingProbe.headers.get("retry-after");

await sleep(1500); // let idle timers + synthesis queue settle

// --- Scene 6c: correlated text submit -> echo carries correlation_id ---
await fetch("http://localhost:17777/submit", {
  method: "POST",
  body: JSON.stringify({ type: "text", content: "correlate me please", id: 4242 }),
});
await sleep(50);
// pi is mocked, so replay the dispatched parts back as pi's echo would arrive.
const dispatched = sent[sent.length - 1];
await fire("message_start", { message: { role: "user", content: dispatched.parts } });
await sleep(50);

// --- Scene 6d: cancel endpoint -> ctx.abort, 204, idempotent ---
const cancel1 = await fetch("http://localhost:17777/cancel", { method: "POST" });
const cancel2 = await fetch("http://localhost:17777/cancel", { method: "POST" });
const cancelGet = await fetch("http://localhost:17777/cancel");
// --- Scene 7: late-attaching listener gets history replay ---
const lateSeen: string[] = [];
await attachListener("late", false, lateSeen);
await sleep(300);

// --- Scene 8: fetch a ready segment + the failed one ---
const seg = await fetch("http://localhost:17777/segments/2/0/audio");
const segBody = seg.ok ? (await seg.text()).slice(0, 60) : `status=${seg.status}`;
const failProbe = await fetch("http://localhost:17777/segments/6/0/audio");

console.log("=== AUDIO LISTENER ===");
for (const l of audioSeen) console.log(l);
console.log("=== TEXT LISTENER (count should match) ===");
console.log(`events: ${textSeen.length} (audio saw ${audioSeen.length})`);
console.log("=== LATE LISTENER (history replay) ===");
for (const l of lateSeen) console.log(l);
console.log("=== SEGMENT FETCH 2/0 ===");
console.log(segBody);
console.log(`=== FAILED SEGMENT 6/0 status=${failProbe.status} ===`);
const slowReady = await fetch(`http://localhost:17777/segments/${slowSeg?.message_id}/0/audio`);
const ghost = await fetch("http://localhost:17777/segments/99/0/audio");
console.log(`=== PENDING SEGMENT ${slowSeg?.message_id}/0 status=${pendingProbe.status} retry-after=${pendingRetryAfter} then=${slowReady.status} ===`);
console.log(`=== UNKNOWN SEGMENT 99/0 status=${ghost.status} ===`);
const lateParsed = lateSeen.map((l) => JSON.parse(l));
const sessionFirst = lateParsed[0]?.event === "session" && typeof lateParsed[0]?.id === "string";
const audioSession = JSON.parse(audioSeen[0] ?? "{}");
const sameEpoch = sessionFirst && audioSession.event === "session" && audioSession.id === lateParsed[0].id;
console.log(`=== SESSION EVENT first-on-attach=${sessionFirst} same-epoch-across-clients=${sameEpoch} ===`);
const corr = lateParsed.find((e) => e.event === "message" && e.content === "correlate me please");
console.log(`=== CORRELATION echo id=${corr?.correlation_id} (want 4242) ===`);
const stamped = lateParsed.filter((e) => e.event === "message").every((e) => typeof e.created_at === "string");
console.log(`=== TIMESTAMPS all-messages=${stamped} ===`);
console.log(`=== CANCEL post=${cancel1.status},${cancel2.status} (want 204,204) get=${cancelGet.status} (want 405) aborts=${aborted} ===`);
console.log("HARNESS_DONE sent=" + JSON.stringify(sent));
await fire("session_shutdown", {});
process.exit(0);
