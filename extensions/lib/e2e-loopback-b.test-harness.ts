// e2e-loopback-b.test-harness.ts — REAL end-to-end text turn through BOTH
// loopbacks, using host subscription credentials. Proves:
//   • claude's auth reaches api.anthropic.com THROUGH loopback B (success ⇒ auth
//     preserved; a stripped/substituted auth would 401),
//   • loopback B captures the real anthropic-ratelimit-* headers for the turn,
//   • loopback A synthesizes correct Anthropic SSE back to the client.
// NO token is ever printed. Run:
//   nix develop .#stt -c bun run extensions/lib/e2e-loopback-b.test-harness.ts
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseAnthropicBody, type AnthropicRequest } from "./anthropic-body.ts";
import { runClaude } from "./claude-runner.ts";
import { createClaudeFacingHandler } from "./loopback-b.ts";

async function main() {
  // Ephemeral config dir with host creds (stands in for FAMILIAR_ANTHROPIC_CLAUDE_CREDENTIALS_JSON).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-lbB-"));
  const cfg = path.join(root, "claude-config");
  fs.mkdirSync(cfg, { recursive: true });
  fs.copyFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), path.join(cfg, ".credentials.json"));

  // ---- LOOPBACK B: real claude-facing gateway → real api.anthropic.com ----
  const ratelimitByTurn = new Map<string, Record<string, string>>();
  const handlerB = createClaudeFacingHandler({
    upstreamBase: "https://api.anthropic.com",
    onRatelimit: (turnId, h) => ratelimitByTurn.set(turnId, h),
    log: () => {},
  });
  const serverB = http.createServer((req, res) => handlerB(req, res));
  await new Promise<void>((r) => serverB.listen(0, "127.0.0.1", () => r()));
  const portB = (serverB.address() as any).port;
  const clBasePrefix = `http://127.0.0.1:${portB}`;

  // ---- LOOPBACK A: pi-facing gateway (spawns claude → loopback B) ---------
  const turnId = "t-e2e-" + Date.now().toString(36);
  const serverA = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/v1/messages")) { res.writeHead(404); res.end(); return; }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const parsed = parseAnthropicBody(JSON.parse(Buffer.concat(chunks).toString()) as AnthropicRequest);
      const lastUser = [...parsed.messages].reverse().find((m) => m.role === "user");
      const prompt = lastUser?.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("") ?? "";
      const run = runClaude({
        stdin: prompt,
        configDir: cfg,
        claudeBaseUrl: `${clBasePrefix}/turn/${turnId}`, // route claude THROUGH loopback B
        model: parsed.model,
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for await (const f of run.frames) res.write(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`);
      await run.done;
      res.end();
    });
  });
  await new Promise<void>((r) => serverA.listen(0, "127.0.0.1", () => r()));
  const portA = (serverA.address() as any).port;

  console.log(`loopback A port=${portA} loopback B port=${portB} isolated=${portA !== portB}`);

  // ---- drive a real text turn through A → claude → B → anthropic ----------
  const reqBody = JSON.stringify({
    model: "claude-opus-4-8",
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "Reply with exactly the word PONG and nothing else." }],
  });
  const events: { event: string; data: any }[] = [];
  await new Promise<void>((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: portA, path: "/anthropic/v1/messages", method: "POST", headers: { "content-type": "application/json" } }, (resp) => {
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
    });
    r.on("error", reject);
    r.write(reqBody); r.end();
  });

  serverA.close(); serverB.close();
  fs.rmSync(root, { recursive: true, force: true });

  const kinds = [...new Set(events.map((e) => e.event))];
  const text = events.filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta").map((e) => e.data.delta.text).join("");
  const delta = events.find((e) => e.event === "message_delta");
  const rl = ratelimitByTurn.get(turnId) ?? {};
  // Print ONLY the ratelimit header KEYS + safe values (status/util) — never a token.
  const rlSafe: Record<string, string> = {};
  for (const [k, v] of Object.entries(rl)) {
    if (k.includes("util") || k.includes("status") || k === "retry-after" || k.includes("reset") || k === "request-id") rlSafe[k] = v;
  }
  console.log("frame kinds:", kinds.join(","));
  console.log("assembled text:", JSON.stringify(text));
  console.log("stop_reason:", delta?.data?.delta?.stop_reason);
  console.log("usage:", JSON.stringify(delta?.data?.usage ?? {}));
  console.log("loopback-B captured ratelimit headers:", JSON.stringify(rlSafe));

  const authReached = kinds.includes("message_start") && kinds.includes("message_stop") && /PONG/i.test(text);
  const rlCaptured = Object.keys(rl).length > 0;
  console.log("auth-reached-upstream (success):", authReached);
  console.log("ratelimit-captured-through-B:", rlCaptured);
  console.log(authReached && rlCaptured ? "E2E LOOPBACK-B PASS ✅" : "E2E LOOPBACK-B FAIL ❌");
  process.exit(authReached && rlCaptured ? 0 : 1);
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
