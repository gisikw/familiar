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

test("attach snapshot saturates an in-flight text/tool projection", () => {
  const hub = new StreamHub();
  hub.revise({
    event: "message", id: 7, role: "assistant", content: "already produced",
    parts: [{ type: "text", text: "already produced" }], revision: 3,
    created_at: "2025-01-01T00:00:00.000Z",
  });
  hub.publish({ event: "tool", id: "call-7", name: "read", args: '{"path":"x"}', message_id: 7 });

  const req = new EventEmitter();
  const res = new ResponseSink();
  hub.attach(req as never, res as never, false);

  const attached = events(res);
  assert.equal(attached[0].event, "session");
  assert.deepEqual(attached.at(-1), {
    event: "message", id: 7, role: "assistant", content: "already produced",
    parts: [
      { type: "text", text: "already produced" },
      { type: "tool", id: "call-7", name: "read", args: '{"path":"x"}' },
    ],
    revision: 3, created_at: "2025-01-01T00:00:00.000Z",
  });
  req.emit("close");
  hub.close();
});

test("agent lifecycle is snapshotted and never retained as transcript history", () => {
  const hub = new StreamHub();
  const liveReq = new EventEmitter();
  const liveRes = new ResponseSink();
  hub.attach(liveReq as never, liveRes as never, false);

  hub.publish({ event: "agent", active: true, after_message_id: 6 });
  assert.equal(hub.agentActive, true);
  assert.equal(hub.agentAfterMessageId, 6);
  assert.deepEqual(events(liveRes).at(-1), {
    event: "agent", active: true, after_message_id: 6,
  });
  liveReq.emit("close");

  const replayReq = new EventEmitter();
  const replayRes = new ResponseSink();
  hub.attach(replayReq as never, replayRes as never, false);
  assert.deepEqual(events(replayRes), [{
    event: "session", id: hub.session, agent_active: true,
    agent_after_message_id: 6,
  }]);

  hub.publish({ event: "agent", active: false });
  assert.equal(hub.agentActive, false);
  replayReq.emit("close");
  hub.close();
});

test("a subsequent authoritative revision replaces rather than duplicates tool parts", () => {
  const hub = new StreamHub();
  hub.revise({
    event: "message", id: 2, role: "assistant", content: "before",
    parts: [{ type: "text", text: "before" }], revision: 1,
  });
  hub.publish({ event: "tool", id: "same", name: "bash", args: "{}", message_id: 2 });
  hub.revise({
    event: "message", id: 2, role: "assistant", content: "beforeafter",
    parts: [
      { type: "text", text: "before" },
      { type: "tool", id: "same", name: "bash", args: '{"command":"true"}' },
      { type: "text", text: "after" },
    ], revision: 2,
  });

  assert.deepEqual(hub.inflight?.parts, [
    { type: "text", text: "before" },
    { type: "tool", id: "same", name: "bash", args: '{"command":"true"}' },
    { type: "text", text: "after" },
  ]);
  hub.close();
});
