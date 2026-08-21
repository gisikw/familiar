// e2e-tools.test-harness.ts — REAL end-to-end proof of v1b: multi-turn +
// tools, driving the actual driver extension against the real claude CLI.
// Run:
//   nix develop .#stt -c bun run extensions/lib/e2e-tools.test-harness.ts
//
// Scenario:
//   Turn 1: user asks claude to call a deterministic fake tool `weather_now`.
//           → loopback A must return a tool_use SSE with correct name+input+id.
//   (pi would run the tool; we synthesize the tool_result.)
//   Turn 2: the SAME conversation, now carrying assistant(tool_use) +
//           tool_result. → a FRESH claude process consumes the projected
//           transcript and returns final text mentioning the result.
//   Also asserts: NO claude process is alive between turns.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { execSync } from "node:child_process";

// Boot the driver with a fake pi and the activation gate set to host creds.
process.env.FAMILIAR_ANTHROPIC_CLAUDE_CREDENTIALS_JSON = fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8");
// Scrub tiamat routing so the driver's child spawn is clean (buildEnv also does this).
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.ANTHROPIC_AUTH_TOKEN;

let baseUrl = "";
const fakePi: any = {
  _shutdown: null as null | (() => Promise<void>),
  on(event: string, cb: any) { if (event === "session_shutdown") this._shutdown = cb; },
  registerProvider(_name: string, cfg: any) { baseUrl = cfg.baseUrl; },
  unregisterProvider() {},
};

const driver = (await import("../claude-driver/index.ts")).default;
await driver(fakePi); // awaits factory → server bound, provider registered

function claudeProcCount(): number {
  try {
    // count claude CLI processes owned by us (exclude this harness/grep)
    const out = execSync("pgrep -a -f 'claude -p' || true", { encoding: "utf8" });
    return out.split("\n").filter((l) => l.includes("claude") && l.includes("-p")).length;
  } catch { return 0; }
}

async function postMessages(body: unknown): Promise<{ event: string; data: any }[]> {
  const payload = JSON.stringify(body);
  const url = new URL(baseUrl + "/v1/messages");
  const events: { event: string; data: any }[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json" } },
      (resp) => {
        let buf = "";
        resp.on("data", (c) => {
          buf += c.toString();
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /event: (.*)/.exec(block)?.[1];
            const da = /data: (.*)/s.exec(block)?.[1];
            if (ev && da) events.push({ event: ev, data: JSON.parse(da) });
          }
        });
        resp.on("end", resolve);
        resp.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(payload); req.end();
  });
  return events;
}

function assembleText(events: { event: string; data: any }[]): string {
  return events.filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta").map((e) => e.data.delta.text).join("");
}
function findToolUse(events: { event: string; data: any }[]): { id: string; name: string; input: any } | null {
  const start = events.find((e) => e.event === "content_block_start" && e.data?.content_block?.type === "tool_use");
  if (!start) return null;
  const idx = start.data.index;
  const inputStr = events.filter((e) => e.event === "content_block_delta" && e.data?.index === idx && e.data?.delta?.type === "input_json_delta").map((e) => e.data.delta.partial_json).join("");
  let input: any = {};
  try { input = JSON.parse(inputStr || "{}"); } catch {}
  return { id: start.data.content_block.id, name: start.data.content_block.name, input };
}

const TOOLS = [{
  name: "weather_now",
  description: "Get the current weather for a city. Returns a short string. Call this whenever the user asks about weather.",
  input_schema: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] },
}];

async function main() {
  let pass = true;
  const fail = (m: string) => { console.log("FAIL: " + m); pass = false; };

  // ---- TURN 1 -------------------------------------------------------------
  const before1 = claudeProcCount();
  const t1 = await postMessages({
    model: "claude-opus-4-8",
    max_tokens: 256,
    stream: true,
    system: "You are a helpful assistant with access to tools. Use them when relevant.",
    tools: TOOLS,
    messages: [{ role: "user", content: "What's the weather in Paris right now? Use your weather tool." }],
  });
  const kinds1 = [...new Set(t1.map((e) => e.event))];
  const tool = findToolUse(t1);
  const delta1 = t1.find((e) => e.event === "message_delta");
  console.log("TURN1 kinds:", kinds1.join(","));
  console.log("TURN1 message_start count:", t1.filter((e) => e.event === "message_start").length);
  console.log("TURN1 tool_use:", JSON.stringify(tool));
  console.log("TURN1 stop_reason:", delta1?.data?.delta?.stop_reason);
  if (t1.filter((e) => e.event === "message_start").length !== 1) fail("turn1 not collapsed to ONE message_start");
  if (!tool) fail("turn1 returned no tool_use");
  else {
    if (tool.name !== "weather_now") fail(`turn1 tool name=${tool.name} (want weather_now)`);
    if (!tool.input || typeof tool.input.city !== "string" || !/paris/i.test(tool.input.city)) fail(`turn1 tool input city wrong: ${JSON.stringify(tool.input)}`);
    if (!/^toolu_/.test(tool.id)) fail(`turn1 tool id not toolu_*: ${tool.id}`);
  }
  if (delta1?.data?.delta?.stop_reason !== "tool_use") fail("turn1 stop_reason != tool_use");

  // No claude process should survive the turn.
  await new Promise((r) => setTimeout(r, 400));
  const between = claudeProcCount();
  console.log(`claude procs: before1=${before1} between=${between}`);
  if (between > before1) fail(`claude process survived between turns (before=${before1} between=${between})`);

  // ---- TURN 2: carry the assistant(tool_use) + our tool_result ------------
  const toolId = tool?.id ?? "toolu_fallback";
  const t2 = await postMessages({
    model: "claude-opus-4-8",
    max_tokens: 256,
    stream: true,
    system: "You are a helpful assistant with access to tools. Use them when relevant.",
    tools: TOOLS,
    messages: [
      { role: "user", content: "What's the weather in Paris right now? Use your weather tool." },
      { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "weather_now", input: tool?.input ?? { city: "Paris" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "SUNNY_42_DEGREES_MARKER" }] },
    ],
  });
  const kinds2 = [...new Set(t2.map((e) => e.event))];
  const text2 = assembleText(t2);
  const delta2 = t2.find((e) => e.event === "message_delta");
  console.log("TURN2 kinds:", kinds2.join(","));
  console.log("TURN2 message_start count:", t2.filter((e) => e.event === "message_start").length);
  console.log("TURN2 text:", JSON.stringify(text2.slice(0, 300)));
  console.log("TURN2 stop_reason:", delta2?.data?.delta?.stop_reason);
  if (!/SUNNY_42_DEGREES_MARKER|42|sunny/i.test(text2)) fail("turn2 final text did not reflect the injected tool_result marker");
  if (t2.filter((e) => e.event === "message_start").length !== 1) fail("turn2 not collapsed to ONE message_start");

  // ---- teardown -----------------------------------------------------------
  await fakePi._shutdown?.();
  await new Promise((r) => setTimeout(r, 300));
  const after = claudeProcCount();
  if (after > before1) fail(`claude process leaked after shutdown (after=${after})`);

  console.log(pass ? "\nE2E TOOLS PASS ✅" : "\nE2E TOOLS FAIL ❌");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
