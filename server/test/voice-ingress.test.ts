/* ============================================================================
 * Voice endpoint / protocol integration test.
 * Run with:  nix develop .#stt -c bun test server/test/voice-ingress.test.ts
 * ============================================================================
 *
 * Proves the SERVER half of the tap-to-talk path end to end, without a
 * microphone and without pi:
 *
 *   browser-shaped POST /submit  { type:"audio", id, seq:0, data, segments:1 }
 *     → Ingress.transcribe (mock FAMILIAR_STT_URL)
 *     → dispatch → RelayBus.send({type:"submit", correlationId, parts})
 *     → a /relay SSE subscriber (stand-in for the extension) receives EXACTLY
 *       ONE submit command carrying the transcript, marked 🗣 and echoing the
 *       client-chosen take id as correlationId.
 *
 * The real Ingress + RelayBus are wired exactly as server/src/main.ts wires
 * them for the /submit and /relay routes (main.ts also imports node-pty, which
 * is not present in the .#stt shell, so we mount only the two relevant routes
 * on our own http.Server rather than importing main). STT is an HTTP stub; the
 * extension subscriber is a raw SSE reader. The wire protocol is exercised for
 * real.
 */
import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import http from "node:http";
import { RelayBus } from "../src/relay.ts";
import { Ingress } from "../src/ingress.ts";

const SERVER_PORT = 17910;
const STT_PORT = 17911;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

// --- mock STT: echoes a deterministic transcript, records that it was hit. ---
let sttHits = 0;
let lastSttBody: Buffer | null = null;
let stt: http.Server;
let server: http.Server;

beforeAll(async () => {
  stt = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      sttHits++;
      lastSttBody = Buffer.concat(chunks);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "hello from the microphone" }));
    });
  });
  await new Promise<void>((r) => stt.listen(STT_PORT, "127.0.0.1", r));

  process.env.FAMILIAR_STT_URL = `http://127.0.0.1:${STT_PORT}`;
  process.env.FAMILIAR_LOG_PATH = "/tmp/familiar-voice-test-log";

  // Same objects, same routes as main.ts's /submit and /relay branches.
  const relay = new RelayBus();
  const ingress = new Ingress(relay);
  server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname === "/relay") return relay.attach(req, res);
    if (pathname === "/submit") return void ingress.handleSubmit(req, res).catch(() => { res.statusCode = 500; res.end(); });
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(SERVER_PORT, "127.0.0.1", r));
});

afterAll(async () => {
  await new Promise<void>((r) => stt.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});

// Minimal /relay SSE reader — stands in for the extension's RelayClient.
function openRelay(onCmd: (cmd: any) => void): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${BASE}/relay`,
      { headers: { Accept: "text/event-stream" } },
      (res) => {
        if (res.statusCode !== 200) return reject(new Error(`relay ${res.statusCode}`));
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const json = line.slice(5).trim();
              if (json) try { onCmd(JSON.parse(json)); } catch { /* ignore */ }
            }
          }
        });
        resolve(() => req.destroy());
      },
    );
    req.on("error", reject);
  });
}

function postSubmit(body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${BASE}/submit`,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: out }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

describe("voice /submit → /relay protocol", () => {
  test("a single audio take produces exactly one 🗣 submit command with the take id", async () => {
    const cmds: any[] = [];
    const close = await openRelay((c) => cmds.push(c));
    await new Promise((r) => setTimeout(r, 100)); // let the relay attach

    // Exactly what voice.js posts: one-segment take, base64 audio.
    const takeId = 55501;
    const fakeAudio = Buffer.from("RIFFfake-wav-bytes").toString("base64");
    const res = await postSubmit({ type: "audio", id: takeId, seq: 0, data: fakeAudio, segments: 1 });
    expect(res.status).toBe(200);

    // Wait for STT + dispatch to land on the relay.
    await new Promise((r) => setTimeout(r, 300));

    const submits = cmds.filter((c) => c.type === "submit");
    expect(submits.length).toBe(1);
    const cmd = submits[0];
    expect(cmd.correlationId).toBe(takeId);
    // parts[0] is the transcript, marked 🗣 so the model prices in STT error.
    expect(cmd.parts[0]).toContain("hello from the microphone");
    expect(cmd.parts[0].startsWith("🗣")).toBe(true);

    // STT actually received the decoded audio bytes.
    expect(sttHits).toBeGreaterThanOrEqual(1);
    expect(lastSttBody?.toString("utf8")).toBe("RIFFfake-wav-bytes");

    close();
  });

  test("malformed audio take is rejected 400 and never reaches the relay", async () => {
    const cmds: any[] = [];
    const close = await openRelay((c) => cmds.push(c));
    await new Promise((r) => setTimeout(r, 100));

    // Missing required fields (no seg/segments/data typing) → parseSubmit null.
    const res = await postSubmit({ type: "audio", id: "not-a-number" });
    expect(res.status).toBe(400);

    await new Promise((r) => setTimeout(r, 150));
    expect(cmds.filter((c) => c.type === "submit").length).toBe(0);
    close();
  });

  test("text submit path still works (regression: shared /submit endpoint)", async () => {
    const cmds: any[] = [];
    const close = await openRelay((c) => cmds.push(c));
    await new Promise((r) => setTimeout(r, 100));

    const res = await postSubmit({ type: "text", content: "typed not spoken", id: 771 });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));

    const submits = cmds.filter((c) => c.type === "submit");
    expect(submits.length).toBe(1);
    expect(submits[0].correlationId).toBe(771);
    expect(submits[0].parts).toContain("typed not spoken");
    close();
  });
});
