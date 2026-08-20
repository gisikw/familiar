// e2e-images.test-harness.ts — REAL end-to-end proof of image support, driving
// the actual driver extension through loopback A → claude -p → loopback B
// against the real claude CLI (2.1.197) with host subscription creds.
// Run:
//   nix develop .#stt -c bun run extensions/lib/e2e-images.test-harness.ts
//
// Scenarios (a tiny generated PNG of a KNOWN color; we ask claude the color):
//   1. DIRECT user image block  → claude names the color (proves inline base64
//      via stdin stream-json reaches claude and pixels are read).
//   2. IMAGE-BEARING tool_result continuation → turn 1 claude calls a
//      `screenshot` tool; we inject a tool_result whose content is [image];
//      turn 2 (fresh claude, --resume over the projected transcript) reads the
//      projected inline-base64 image and names the color. Proves the tool-result
//      image path end-to-end.
// Never prints OAuth / creds.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as zlib from "node:zlib";

process.env.FAMILIAR_ANTHROPIC_OAUTH = fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8");
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.ANTHROPIC_AUTH_TOKEN;

// ---- generate a tiny solid-color PNG (distinct, unambiguous color) ----------
function crc32(buf: Buffer): number { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }
function pngChunk(type: string, data: Buffer): Buffer { const t = Buffer.from(type, "ascii"); const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const body = Buffer.concat([t, data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0); return Buffer.concat([len, body, crc]); }
function makePng(w: number, h: number, rgb: [number, number, number]): Buffer { const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[1 + x * 3 + 1] = rgb[1]; row[1 + x * 3 + 2] = rgb[2]; } const raw = Buffer.concat(Array.from({ length: h }, () => row)); const idat = zlib.deflateSync(raw); return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]); }

const GREEN_B64 = makePng(96, 96, [20, 200, 40]).toString("base64"); // vivid green
const PURPLE_B64 = makePng(96, 96, [150, 30, 200]).toString("base64"); // vivid purple

let baseUrl = "";
const fakePi: any = {
  _shutdown: null as null | (() => Promise<void>),
  on(event: string, cb: any) { if (event === "session_shutdown") this._shutdown = cb; },
  registerProvider(_n: string, cfg: any) { baseUrl = cfg.baseUrl; },
  unregisterProvider() {},
};

const driver = (await import(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "claude-driver.ts"))).default;
await driver(fakePi);

async function postMessages(body: unknown): Promise<{ event: string; data: any }[]> {
  const payload = JSON.stringify(body);
  const url = new URL(baseUrl + "/v1/messages");
  const events: { event: string; data: any }[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json" } }, (resp) => {
      let buf = "";
      resp.on("data", (c) => { buf += c.toString(); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /event: (.*)/.exec(block)?.[1]; const da = /data: (.*)/s.exec(block)?.[1]; if (ev && da) events.push({ event: ev, data: JSON.parse(da) }); } });
      resp.on("end", resolve); resp.on("error", reject);
    });
    req.on("error", reject); req.write(payload); req.end();
  });
  return events;
}
const assembleText = (evs: { event: string; data: any }[]) => evs.filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta").map((e) => e.data.delta.text).join("");
function findToolUse(evs: { event: string; data: any }[]) { const s = evs.find((e) => e.event === "content_block_start" && e.data?.content_block?.type === "tool_use"); if (!s) return null; const idx = s.data.index; const inputStr = evs.filter((e) => e.event === "content_block_delta" && e.data?.index === idx && e.data?.delta?.type === "input_json_delta").map((e) => e.data.delta.partial_json).join(""); let input: any = {}; try { input = JSON.parse(inputStr || "{}"); } catch {} return { id: s.data.content_block.id, name: s.data.content_block.name, input }; }

async function main() {
  let pass = true;
  const fail = (m: string) => { console.log("FAIL: " + m); pass = false; };

  // ---- SCENARIO 1: direct user image block --------------------------------
  console.log("\n--- SCENARIO 1: direct user image (inline base64) ---");
  const s1 = await postMessages({
    model: "claude-opus-4-8", max_tokens: 64, stream: true,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: GREEN_B64 } },
      { type: "text", text: "Reply with ONLY the single dominant color word of this image (e.g. green, blue, purple)." },
    ] }],
  });
  const text1 = assembleText(s1);
  console.log("S1 message_start count:", s1.filter((e) => e.event === "message_start").length);
  console.log("S1 text:", JSON.stringify(text1.slice(0, 200)));
  if (!/green/i.test(text1)) fail("scenario 1: claude did not identify the GREEN image");

  // ---- SCENARIO 2: image-bearing tool_result continuation -----------------
  console.log("\n--- SCENARIO 2: image-bearing tool_result continuation ---");
  const TOOLS = [{ name: "screenshot", description: "Capture a screenshot of the current screen. Returns an image. Call this when the user asks to see or capture the screen.", input_schema: { type: "object", properties: {} } }];
  const t1 = await postMessages({
    model: "claude-opus-4-8", max_tokens: 128, stream: true,
    system: "You are a helpful assistant with a screenshot tool. Use it when asked to look at the screen.",
    tools: TOOLS,
    messages: [{ role: "user", content: "Take a screenshot and tell me the dominant color you see." }],
  });
  const tool = findToolUse(t1);
  console.log("S2 turn1 tool_use:", JSON.stringify(tool));
  if (!tool || tool.name !== "screenshot") { fail("scenario 2: turn1 did not call screenshot tool"); }
  const toolId = tool?.id ?? "toolu_fallback";

  // Inject the tool_result as an IMAGE (purple), then continue.
  const t2 = await postMessages({
    model: "claude-opus-4-8", max_tokens: 64, stream: true,
    system: "You are a helpful assistant with a screenshot tool. Use it when asked to look at the screen.",
    tools: TOOLS,
    messages: [
      { role: "user", content: "Take a screenshot and tell me the dominant color you see." },
      { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "screenshot", input: tool?.input ?? {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PURPLE_B64 } }] }] },
    ],
  });
  const text2 = assembleText(t2);
  console.log("S2 turn2 message_start count:", t2.filter((e) => e.event === "message_start").length);
  console.log("S2 turn2 text:", JSON.stringify(text2.slice(0, 200)));
  if (!/purple|violet|magenta/i.test(text2)) fail("scenario 2: claude did not read the PURPLE tool_result image");

  // ---- SCENARIO 3: policy rejection surfaces (never silently drops) --------
  console.log("\n--- SCENARIO 3: malformed image → actionable error ---");
  const s3 = await postMessages({
    model: "claude-opus-4-8", max_tokens: 32, stream: true,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/tiff", data: GREEN_B64 } },
      { type: "text", text: "hi" },
    ] }],
  });
  const err3 = s3.find((e) => e.event === "error");
  console.log("S3 error:", JSON.stringify(err3?.data?.error?.message?.slice(0, 160)));
  if (!err3 || !/unsupported media type/i.test(err3.data?.error?.message ?? "")) fail("scenario 3: unsupported media type not surfaced as actionable error");

  await fakePi._shutdown?.();
  console.log(pass ? "\nE2E IMAGES PASS ✅" : "\nE2E IMAGES FAIL ❌");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
