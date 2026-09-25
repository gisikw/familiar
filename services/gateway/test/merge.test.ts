import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Channel } from "../src/channels.ts";
import { handleMerge } from "../src/merge.ts";

class ResponseSink {
  statusCode = 200;
  body = "";
  writeHead() {}
  write(value = "") { this.body += value; return true; }
  end(value = "") { this.body += value; }
}
class RequestSource extends EventEmitter {
  constructor(public method: string, body = "") {
    super();
    queueMicrotask(() => { if (body) this.emit("data", body); this.emit("end"); });
  }
}
class RelaySink extends ResponseSink {
  frames: string[] = [];
  override write(value = "") { this.frames.push(value); return true; }
}
const commands = (sink: RelaySink) => sink.frames
  .filter((frame) => frame.startsWith("data: "))
  .map((frame) => JSON.parse(frame.slice(6)));

test("POST /merge relays a content-neutral command to the selected fork", async () => {
  const channel = new Channel("fork", "fork", "parent");
  const relayReq = new EventEmitter();
  const relayRes = new RelaySink();
  channel.relay.attach(relayReq as never, relayRes as never);
  const res = new ResponseSink();

  await handleMerge(new RequestSource("POST", '{"quiet":true}') as never, res as never, channel);
  assert.equal(res.statusCode, 204);
  assert.deepEqual(commands(relayRes), [{ type: "merge", quiet: true }]);
  relayReq.emit("close");
  channel.close();
});

test("POST /merge rejects a primary because it has no parent", async () => {
  const channel = new Channel("primary", "primary");
  const res = new ResponseSink();
  await handleMerge(new RequestSource("POST") as never, res as never, channel);
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /no parent/);
  channel.close();
});
