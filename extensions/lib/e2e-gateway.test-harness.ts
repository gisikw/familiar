// e2e-gateway.ts — standalone end-to-end proof of the pi-facing gateway against
// the REAL claude CLI, without booting pi. Mirrors claude-driver/index.ts's server
// wiring. Run:
//   nix develop .#stt -c bun run extensions/lib/e2e-gateway.test-harness.ts
// Requires: a real ~/.claude/.credentials.json on the host (copied into an
// ephemeral CLAUDE_CONFIG_DIR, exactly as the extension does via
// FAMILIAR_ANTHROPIC_CLAUDE_CREDENTIALS_JSON).
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseAnthropicBody, type AnthropicRequest } from "./anthropic-body.ts";
import { runClaude } from "./claude-runner.ts";

function startGateway(configDir: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST" || !req.url?.endsWith("/v1/messages")) {
        res.writeHead(404); res.end(); return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as AnthropicRequest;
        const parsed = parseAnthropicBody(body);
        const lastUser = [...parsed.messages].reverse().find((m) => m.role === "user");
        const prompt = lastUser?.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("") ?? "";
        const run = runClaude({ stdin: prompt, configDir, model: parsed.model });
        res.writeHead(200, { "content-type": "text/event-stream" });
        for await (const f of run.frames) {
          res.write(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`);
        }
        await run.done;
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as any).port, close: () => server.close() });
    });
  });
}

async function main() {
  // Set up an ephemeral config dir with the host credentials (stands in for
  // FAMILIAR_ANTHROPIC_CLAUDE_CREDENTIALS_JSON materialization).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-claude-"));
  const cfg = path.join(root, "claude-config");
  fs.mkdirSync(cfg, { recursive: true });
  fs.copyFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), path.join(cfg, ".credentials.json"));

  // Prove ephemeral-port isolation: two gateways, distinct ports.
  const g1 = await startGateway(cfg);
  const g2 = await startGateway(cfg);
  console.log(`gateway A port=${g1.port} gateway B port=${g2.port} isolated=${g1.port !== g2.port}`);
  if (g1.port === g2.port) throw new Error("PORT COLLISION");
  g2.close();

  const reqBody = JSON.stringify({
    model: "claude-opus-4-8",
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "Reply with exactly the word PONG and nothing else." }],
  });

  const events: { event: string; data: any }[] = [];
  await new Promise<void>((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: g1.port, path: "/anthropic/v1/messages", method: "POST", headers: { "content-type": "application/json" } },
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
    r.on("error", reject);
    r.write(reqBody); r.end();
  });

  g1.close();
  fs.rmSync(root, { recursive: true, force: true });

  const kinds = events.map((e) => e.event);
  const text = events
    .filter((e) => e.event === "content_block_delta" && e.data?.delta?.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");
  const delta = events.find((e) => e.event === "message_delta");
  console.log("frame kinds:", [...new Set(kinds)].join(","));
  console.log("assembled text:", JSON.stringify(text));
  console.log("stop_reason:", delta?.data?.delta?.stop_reason);
  console.log("usage:", JSON.stringify(delta?.data?.usage ?? {}));

  const ok = kinds.includes("message_start") && kinds.includes("message_stop") && /PONG/i.test(text);
  console.log(ok ? "E2E PASS ✅" : "E2E FAIL ❌");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
