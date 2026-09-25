import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ChannelRegistry } from "../src/channels.ts";
import type { IngestEnvelope } from "../src/protocol.ts";

class ResponseSink {
  frames: string[] = [];
  writeHead() {}
  write(frame: string) { this.frames.push(frame); return true; }
  end() {}
}
const identity = (sessionId: string, role: "primary" | "fork" = "fork") => ({ sessionId, role });
const envelope = (sessionId: string, content: string): IngestEnvelope => ({
  ...identity(sessionId), kind: "publish",
  event: { event: "message", id: 1, role: "assistant", content },
});
const data = (sink: ResponseSink) => sink.frames.filter(f => f.startsWith("data: ")).map(f => JSON.parse(f.slice(6)));

test("channels do not cross-reset or cross-relay", () => {
  const registry = new ChannelRegistry();
  const a = registry.ingest({ ...identity("a"), kind: "session" });
  const b = registry.ingest({ ...identity("b"), kind: "session" });
  a.apply(envelope("a", "from a"));
  b.apply(envelope("b", "from b"));

  const oldBEpoch = b.hub.session;
  a.apply({ ...identity("a"), kind: "session" });
  assert.equal(b.hub.session, oldBEpoch);
  const streamReq = new EventEmitter();
  const streamRes = new ResponseSink();
  b.hub.attach(streamReq as never, streamRes as never, false);
  assert.equal(data(streamRes).at(-1)?.content, "from b");

  const relayReqA = new EventEmitter(), relayReqB = new EventEmitter();
  const relayA = new ResponseSink(), relayB = new ResponseSink();
  a.relay.attach(relayReqA as never, relayA as never);
  b.relay.attach(relayReqB as never, relayB as never);
  a.relay.send({ type: "cancel" });
  assert.deepEqual(data(relayA), [{ type: "cancel" }]);
  assert.deepEqual(data(relayB), []);

  streamReq.emit("close"); relayReqA.emit("close"); relayReqB.emit("close");
  registry.close();
});

test("an omitted session selects the most recently registered primary", () => {
  const registry = new ChannelRegistry();
  registry.register({ sessionId: "primary-old", role: "primary" });
  const latest = registry.register({ sessionId: "primary-new", role: "primary" });
  registry.register({ sessionId: "fork", role: "fork", parentSessionId: "primary-new" });
  assert.equal(registry.get(undefined), latest);
  assert.equal(registry.get("fork")?.parentSessionId, "primary-new");
  registry.close();
});

test("a detached relay channel expires after its retention window", async () => {
  const registry = new ChannelRegistry(10);
  const channel = registry.register({ sessionId: "short-lived", role: "fork", parentSessionId: "primary" });
  const req = new EventEmitter();
  channel.relay.attach(req as never, new ResponseSink() as never);
  req.emit("close");
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(registry.channels.has("short-lived"), false);
  registry.close();
});
