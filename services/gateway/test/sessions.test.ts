import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelRegistry } from "../src/channels.ts";
import { SessionCatalog } from "../src/sessions.ts";

class ResponseSink { writeHead() {} write() { return true; } end() {} }

function fixture(root: string, id: string, markers: string[]) {
  const fork = path.join(root, "forks", id);
  const sessions = path.join(fork, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const sessionFile = path.join(sessions, `${id}.jsonl`);
  fs.writeFileSync(sessionFile, markers.map((customType, i) => JSON.stringify({ type: "custom", id: String(i), customType })).join("\n") + "\n");
  fs.writeFileSync(path.join(fork, "fork.json"), JSON.stringify({
    id, parentSessionId: "parent", task: `task ${id}`, sessionFile,
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
}

test("sessions derive live, merging, merged, and stopped from fixtures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-sessions-"));
  const registry = new ChannelRegistry();
  try {
    fixture(root, "live", []);
    fixture(root, "stopped", []);
    fixture(root, "merging", ["familiar.merge-pending.v1"]);
    fixture(root, "merged", ["familiar.merge-pending.v1", "familiar.merge-sent.v1"]);

    const live = registry.register({ sessionId: "live", role: "fork", parentSessionId: "parent" });
    const req = new EventEmitter();
    live.relay.attach(req as never, new ResponseSink() as never);

    const states = Object.fromEntries(new SessionCatalog(registry, root).list().map(s => [s.id, s.state]));
    assert.deepEqual(states, { live: "live", stopped: "stopped", merging: "merging", merged: "merged" });
    req.emit("close");
  } finally {
    registry.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a pending marker after an older sent marker is merging", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-sessions-"));
  const registry = new ChannelRegistry();
  try {
    fixture(root, "again", ["familiar.merge-sent.v1", "familiar.merge-pending.v1"]);
    assert.equal(new SessionCatalog(registry, root).list()[0].state, "merging");
  } finally {
    registry.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
