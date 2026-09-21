import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { lstatSync, statSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  ImpIngress,
  IMP_AGENT_HANDLER,
  IMP_ATTN_HANDLER,
  IMP_PLATE_HANDLER,
} from "./ingress.mjs";

function call(path, request, suffix = "\n") {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let raw = "";
    socket.on("connect", () => socket.write(JSON.stringify(request) + suffix));
    socket.on("data", (chunk) => raw += chunk);
    socket.on("error", reject);
    socket.on("close", () => resolve(raw));
  });
}

test("one private socket dynamically routes only fixed Plate, Agent, and Attention symbols", async (t) => {
  const old = process.env.FAMILIAR_IMP_SOCKET;
  const ingress = new ImpIngress();
  const path = await ingress.start();
  t.after(async () => {
    delete process[IMP_PLATE_HANDLER];
    delete process[IMP_AGENT_HANDLER];
    delete process[IMP_ATTN_HANDLER];
    await ingress.stop();
    if (old === undefined) delete process.env.FAMILIAR_IMP_SOCKET;
    else process.env.FAMILIAR_IMP_SOCKET = old;
  });
  assert.equal(process.env.FAMILIAR_IMP_SOCKET, path);
  assert.equal(lstatSync(path).mode & 0o077, 0);
  assert.equal(statSync(dirname(path)).mode & 0o077, 0);
  let envelope = JSON.parse(await call(path, { version: 1, area: "plate", operation: "list", args: {} }));
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "unavailable");
  process[IMP_PLATE_HANDLER] = { handle: (request) => ({ from: request.area, operation: request.operation }) };
  process[IMP_AGENT_HANDLER] = { handle: (request) => ({ from: request.area, operation: request.operation }) };
  process[IMP_ATTN_HANDLER] = { handle: (request) => ({ from: request.area, operation: request.operation }) };
  for (const area of ["plate", "agent", "attn"]) {
    envelope = JSON.parse(await call(path, { version: 1, area, operation: "status", args: {} }));
    assert.deepEqual(envelope, { ok: true, result: { from: area, operation: "status" } });
  }
  delete process[IMP_AGENT_HANDLER];
  envelope = JSON.parse(await call(path, { version: 1, area: "agent", operation: "status", args: {} }));
  assert.equal(envelope.error.code, "unavailable");
  assert.equal(JSON.parse(await call(path, { version: 1, area: "other", operation: "x", args: {} })).error.code, "invalid_request");
  assert.equal(JSON.parse(await call(path, { version: 1, area: "plate", operation: "x", args: {}, extra: true })).error.code, "invalid_request");
  // Only the three own-property areas route; inherited object keys are not areas.
  assert.equal(JSON.parse(await call(path, { version: 1, area: "constructor", operation: "x", args: {} })).error.code, "invalid_request");
  assert.equal(JSON.parse(await call(path, { version: 1, area: "attention", operation: "status", args: {} })).error.code, "invalid_request");
  process.env.FAMILIAR_IMP_SOCKET = "/new-owner/value";
  await ingress.stop();
  assert.equal(process.env.FAMILIAR_IMP_SOCKET, "/new-owner/value", "shutdown unsets only its own value");
  assert.equal(existsSync(dirname(path)), false);
});

test("oversized and non-single-record requests fail closed without invoking handlers", async (t) => {
  const ingress = new ImpIngress();
  const path = await ingress.start();
  t.after(async () => { delete process[IMP_PLATE_HANDLER]; await ingress.stop(); });
  let calls = 0;
  process[IMP_PLATE_HANDLER] = { handle: () => { calls++; return {}; } };
  assert.equal(await call(path, { version: 1, area: "plate", operation: "list", args: {} }, "\n{}\n"), "");
  await new Promise((resolve) => {
    const socket = createConnection(path);
    socket.on("connect", () => socket.end("x".repeat((1 << 20) + 1)));
    socket.on("close", resolve);
  });
  assert.equal(calls, 0);
});

test("attn resolves via Symbol.for('familiar.imp.attn.v1') and passes handler error codes through", async (t) => {
  assert.equal(IMP_ATTN_HANDLER, Symbol.for("familiar.imp.attn.v1"));
  const ingress = new ImpIngress();
  const path = await ingress.start();
  t.after(async () => { delete process[IMP_ATTN_HANDLER]; await ingress.stop(); });
  let envelope = JSON.parse(await call(path, { version: 1, area: "attn", operation: "status", args: {} }));
  assert.deepEqual(envelope, { ok: false, error: { code: "unavailable", message: "attn unavailable in this owning Familiar resident" } });
  const seen = [];
  process[Symbol.for("familiar.imp.attn.v1")] = {
    handle(request) {
      seen.push(request);
      if (request.operation === "card.get") throw Object.assign(new Error("no such card"), { code: "not_found" });
      if (request.operation === "card.set") throw Object.assign(new Error("revision moved"), { code: "conflict" });
      if (request.operation === "project.add") throw Object.assign(new Error("bad slug"), { code: "invalid_request" });
      if (request.operation === "boom") throw Object.assign(new Error("disk"), { code: "SQLITE_BUSY" });
      return { agents: { running: 0, blocked: 0 }, needs_attention: 0, inflight: 0, jots: { open: 0, stale: 0 } };
    },
  };
  envelope = JSON.parse(await call(path, { version: 1, area: "attn", operation: "status", args: {} }));
  assert.equal(envelope.ok, true);
  assert.deepEqual(seen, [{ version: 1, area: "attn", operation: "status", args: {} }]);
  for (const [operation, code] of [["card.get", "not_found"], ["card.set", "conflict"], ["project.add", "invalid_request"], ["boom", "operation_failed"]]) {
    envelope = JSON.parse(await call(path, { version: 1, area: "attn", operation, args: { id: "x" } }));
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, code, operation);
  }
});
