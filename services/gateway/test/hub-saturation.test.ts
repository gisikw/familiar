import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { StreamHub } from "../src/hub.ts";

class ResponseSink {
  frames: string[] = [];
  writeHead() { /* SSE headers are not under test. */ }
  write(frame: string) { this.frames.push(frame); return true; }
  end() { /* no-op */ }
}

function events(sink: ResponseSink): any[] {
  return sink.frames
    .filter(frame => frame.startsWith("data: "))
    .map(frame => JSON.parse(frame.slice(6)));
}

test("latest saturation is live and repeated on the attach snapshot", () => {
  const hub = new StreamHub();
  const liveReq = new EventEmitter();
  const liveRes = new ResponseSink();
  hub.attach(liveReq as never, liveRes as never, false);

  hub.publish({ event: "saturation", saturation: 0.25 });
  hub.publish({ event: "saturation", saturation: 0.625 });
  assert.deepEqual(events(liveRes).slice(-2), [
    { event: "saturation", saturation: 0.25 },
    { event: "saturation", saturation: 0.625 },
  ]);

  const attachReq = new EventEmitter();
  const attachRes = new ResponseSink();
  hub.attach(attachReq as never, attachRes as never, false);
  assert.deepEqual(events(attachRes), [
    { event: "session", id: hub.session, saturation: 0.625, agent_active: false },
  ]);

  liveReq.emit("close");
  attachReq.emit("close");
  hub.close();
});

test("a new Pi session clears the saturation snapshot", () => {
  const hub = new StreamHub();
  hub.publish({ event: "saturation", saturation: 0.8 });
  hub.newSession();

  const req = new EventEmitter();
  const res = new ResponseSink();
  hub.attach(req as never, res as never, false);
  assert.deepEqual(events(res), [{
    event: "session", id: hub.session, agent_active: false,
  }]);

  req.emit("close");
  hub.close();
});
