import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ChannelRegistry } from "../src/channels.ts";
import type { IngestEnvelope } from "../src/protocol.ts";

// Fake TTS: the "wav" is just the input text, so a served segment says which
// turn it came from.
async function fakeTts() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => { res.end(JSON.parse(body).input); });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  process.env.FAMILIAR_TTS_URL = `http://127.0.0.1:${port}`;
  return server;
}

class Res {
  statusCode = 200; body = "";
  writeHead(code: number) { this.statusCode = code; }
  end(b?: Buffer) { if (b) this.body = b.toString(); }
}

const id = { sessionId: "p", role: "primary" as const };
const segment = (text: string): IngestEnvelope => ({
  ...id, kind: "publish", event: { event: "segment", message_id: 5, index: 0, text } as never,
});

async function served(ch: ReturnType<ChannelRegistry["ingest"]>) {
  for (let i = 0; i < 50; i++) {
    const res = new Res();
    ch.audio.serve(5, 0, res as never);
    if (res.statusCode === 200) return res.body;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error("segment never became ready");
}

test("a new pi session drops cached audio so reused ids can't replay an old turn", async () => {
  const tts = await fakeTts();
  const registry = new ChannelRegistry();
  const ch = registry.ingest({ ...id, kind: "session" });
  ch.audio.register(5, 0, "Reading the lazy way isn't wrong.", true);
  assert.equal(await served(ch), "Reading the lazy way isn't wrong.");

  ch.apply({ ...id, kind: "session" }); // instance restart: id space resets
  ch.audio.register(5, 0, "Laundry, pack, photo later.", true);
  assert.equal(await served(ch), "Laundry, pack, photo later.");
  registry.close(); tts.close();
});

test("a different text under the same key replaces the stale entry", async () => {
  const tts = await fakeTts();
  const registry = new ChannelRegistry();
  const ch = registry.ingest({ ...id, kind: "session" });
  ch.apply(segment("old turn"));
  assert.equal(await served(ch), "old turn");
  ch.apply(segment("old turn")); // replay of the same segment: kept
  assert.equal(await served(ch), "old turn");
  ch.apply(segment("new turn")); // same id, new content: replaced
  assert.equal(await served(ch), "new turn");
  registry.close(); tts.close();
});
