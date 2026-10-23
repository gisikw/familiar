import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { ChannelRegistry, CLIP_INDEX_BASE } from "../src/channels.ts";
import { handlePlay } from "../src/play.ts";

class Sink {
  frames: string[] = []; status = 0; headers: Record<string, unknown> = {}; body = Buffer.alloc(0); headersSent = false;
  writeHead(s: number, h?: Record<string, unknown>) { this.status = s; this.headers = h ?? {}; this.headersSent = true; }
  write(frame: string) { this.frames.push(frame); return true; }
  end(b?: string | Buffer) { if (b) this.body = Buffer.from(b); }
  set statusCode(s: number) { this.status = s; }
}
const id = { sessionId: "p", role: "primary" as const };
const events = (s: Sink) => s.frames.filter(f => f.startsWith("data: ")).map(f => JSON.parse(f.slice(6)));
function req(body: Buffer, headers: Record<string, string>) {
  const r = Readable.from([body]) as Readable & { method: string; headers: Record<string, string> };
  r.method = "POST"; r.headers = { "content-length": String(body.length), ...headers };
  return r;
}

test("a clip queues after the current message's speech and serves its own bytes", async () => {
  const ch = new ChannelRegistry().ingest({ ...id, kind: "session" });
  const listener = new Sink();
  ch.hub.attach(new EventEmitter() as never, listener as never, true);
  ch.apply({ ...id, kind: "publish", event: { event: "message", id: 7, role: "assistant", content: "Here it is." } });
  ch.apply({ ...id, kind: "publish", event: { event: "segment", message_id: 7, index: 0, text: "Here it is.", synthesizing: true } });

  const res = new Sink();
  await handlePlay(req(Buffer.from("ID3fake"), { "content-type": "audio/mpeg", "x-clip-title": "Hinton%20clip" }) as never, res as never, ch);
  const out = JSON.parse(res.body.toString());
  assert.deepEqual(out, { played: true, message_id: 7, index: CLIP_INDEX_BASE });
  const seg = events(listener).find(e => e.event === "segment" && e.index === CLIP_INDEX_BASE);
  assert.equal(seg.message_id, 7);
  assert.equal(seg.text, "[clip] Hinton clip");

  const audio = new Sink();
  ch.audio.serve(7, CLIP_INDEX_BASE, audio as never);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers["Content-Type"], "audio/mpeg");
  assert.equal(audio.body.toString(), "ID3fake");

  // A second clip in the same message goes after the first; a new message restarts the count.
  const res2 = new Sink();
  await handlePlay(req(Buffer.from("x"), { "content-type": "audio/wav" }) as never, res2 as never, ch);
  assert.equal(JSON.parse(res2.body.toString()).index, CLIP_INDEX_BASE + 1);
  ch.apply({ ...id, kind: "revise", event: { event: "message", id: 8, role: "assistant", content: "" } });
  const res3 = new Sink();
  await handlePlay(req(Buffer.from("x"), { "content-type": "audio/wav" }) as never, res3 as never, ch);
  assert.deepEqual(JSON.parse(res3.body.toString()), { played: true, message_id: 8, index: CLIP_INDEX_BASE });
  ch.close(); // stops the hub heartbeat so node can exit
});

test("no speaker on: nothing queued, caller told", async () => {
  const ch = new ChannelRegistry().ingest({ ...id, kind: "session" });
  const res = new Sink();
  await handlePlay(req(Buffer.from("x"), { "content-type": "audio/mpeg" }) as never, res as never, ch);
  assert.deepEqual(JSON.parse(res.body.toString()), { played: false, reason: "no-listener" });
  assert.equal(ch.hub["history"].filter((e: { event: string }) => e.event === "segment").length, 0);
});

test("rejects non-audio and empty bodies", async () => {
  const ch = new ChannelRegistry().ingest({ ...id, kind: "session" });
  const a = new Sink();
  await handlePlay(req(Buffer.from("x"), { "content-type": "text/plain" }) as never, a as never, ch);
  assert.equal(a.status, 415);
  const b = new Sink();
  await handlePlay(req(Buffer.alloc(0), { "content-type": "audio/wav" }) as never, b as never, ch);
  assert.equal(b.status, 400);
});
