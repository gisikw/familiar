import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceCall } from "./familiar-services.ts";
import { WorklistClient } from "../worklist/store.ts";
import { WakeClient } from "../wake/store.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

async function fakeService(handle: (request: { op: string; args: Record<string, unknown> }) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), "familiar-services-client-"));
  const socketPath = join(dir, "service.sock");
  const requests: Array<{ op: string; args: Record<string, unknown> }> = [];
  const server: Server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      requests.push(request);
      const response = handle(request);
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  cleanup.push(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { socketPath, requests };
}

describe("familiar-services socket client", () => {
  test("sends one newline-delimited request and returns its result", async () => {
    const fake = await fakeService((request) => ({ ok: true, result: { echoed: request.op } }));
    expect(await serviceCall("worklist.list", {}, fake.socketPath)).toEqual({ echoed: "worklist.list" });
    expect(fake.requests).toEqual([{ op: "worklist.list", args: {} }]);
  });

  test("preserves service error codes and clearly reports an unavailable socket", async () => {
    const fake = await fakeService(() => ({ ok: false, error: { code: "not_found", message: "missing item" } }));
    try { await serviceCall("worklist.ack", { id: "gone" }, fake.socketPath); throw new Error("expected rejection"); }
    catch (error) { expect((error as { code?: string }).code).toBe("not_found"); expect(String(error)).toContain("missing item"); }
    await expect(serviceCall("worklist.list", {}, join(tmpdir(), "definitely-absent-familiar.sock"))).rejects.toThrow("familiar-services unavailable");
  });

  test("worklist and DND wrappers use the M2 operations", async () => {
    const item = { id: "one", ts: 1, priority: 2, type: "notify", summary: "hello", body: "hello", source: "test" };
    const fake = await fakeService((request) => ({ ok: true, result:
      request.op === "worklist.list" ? [item] : request.op === "worklist.enqueue" ? { item, created: true } : request.op === "dnd.get" ? null : item,
    }));
    const client = new WorklistClient(fake.socketPath);
    expect(await client.list()).toEqual([item]);
    expect((await client.enqueue({ summary: "hello" })).created).toBe(true);
    await client.ack("one"); await client.withdraw("one"); await client.getDnd(); await client.setDnd(true, "familiar", 1000);
    expect(fake.requests.map((request) => request.op)).toEqual(["worklist.list", "worklist.enqueue", "worklist.ack", "worklist.withdraw", "dnd.get", "dnd.set"]);
    expect(fake.requests.at(-1)?.args).toEqual({ enabled: true, set_by: "familiar", duration_ms: 1000 });
  });

  test("wake wrapper schedules, lists, and client-cancels older unless_wakened wakes", async () => {
    const wakes = [
      { version: 1, id: "nap", mode: "unless_wakened", reason: "nap", scheduledAt: 10, fireAt: 100 },
      { version: 1, id: "alarm", mode: "always", reason: "alarm", scheduledAt: 10, fireAt: 100 },
    ];
    const fake = await fakeService((request) => ({ ok: true, result: request.op === "wake.list" ? wakes : request.op === "wake.cancel" ? { cancelled: true } : wakes[0] }));
    const client = new WakeClient(fake.socketPath);
    await client.schedule("unless_wakened", "nap", 1);
    await client.freshActivity(11);
    expect(fake.requests.map((request) => request.op)).toEqual(["wake.schedule", "wake.list", "wake.cancel"]);
    expect(fake.requests.at(-1)?.args).toEqual({ id: "nap" });
  });
});
