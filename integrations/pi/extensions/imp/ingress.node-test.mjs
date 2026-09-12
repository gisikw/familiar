import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { lstatSync, statSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  ImpIngress,
  IMP_AGENT_HANDLER,
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

test("one private socket dynamically routes only fixed Plate and Agent symbols", async (t) => {
  const old = process.env.FAMILIAR_IMP_SOCKET;
  const ingress = new ImpIngress();
  const path = await ingress.start();
  t.after(async () => {
    delete process[IMP_PLATE_HANDLER];
    delete process[IMP_AGENT_HANDLER];
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
  for (const area of ["plate", "agent"]) {
    envelope = JSON.parse(await call(path, { version: 1, area, operation: "status", args: {} }));
    assert.deepEqual(envelope, { ok: true, result: { from: area, operation: "status" } });
  }
  delete process[IMP_AGENT_HANDLER];
  envelope = JSON.parse(await call(path, { version: 1, area: "agent", operation: "status", args: {} }));
  assert.equal(envelope.error.code, "unavailable");
  assert.equal(JSON.parse(await call(path, { version: 1, area: "other", operation: "x", args: {} })).error.code, "invalid_request");
  assert.equal(JSON.parse(await call(path, { version: 1, area: "plate", operation: "x", args: {}, extra: true })).error.code, "invalid_request");
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
