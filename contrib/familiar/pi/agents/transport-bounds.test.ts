import { afterEach, expect, test } from "bun:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { getEventListeners } from "node:events";
import { GolemClient } from "./api.ts";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function client(
  handler: (res: ServerResponse) => void,
  bytes = 128,
  timeout = 60,
) {
  const server = createServer((_req, res) => handler(res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  return new GolemClient(`http://127.0.0.1:${address.port}`, "", {
    responseBytes: bytes,
    timeoutMs: timeout,
  });
}

test("absolute request deadline defeats trickled bytes, retaining uncertain-outcome warning", async () => {
  const api = await client((res) => {
    const timer = setInterval(() => res.write(" "), 5);
    res.on("close", () => clearInterval(timer));
  });
  await expect(api.status("job")).rejects.toThrow("outcome may be uncertain");
});

test("response budget is enforced while streaming, before Buffer.concat", async () => {
  const api = await client((res) => res.end("x".repeat(256)));
  await expect(api.status("job")).rejects.toThrow("byte budget");
});

test("truncated response rejects instead of leaving cancellation awaiting forever", async () => {
  const api = await client((res) => {
    res.writeHead(200, { "content-length": "1000" });
    res.write("x");
    setTimeout(() => res.destroy(), 5);
  });
  await expect(api.cancel("job")).rejects.toThrow();
});

test("unterminated SSE frame cannot exceed memory budget", async () => {
  const api = await client((res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: " + "x".repeat(256));
  });
  await expect(
    api.streamEvents(0, () => {}, new AbortController().signal),
  ).rejects.toThrow("byte budget");
});

test("completed SSE requests detach abort listeners across reconnects", async () => {
  const api = await client((res) => res.end('data: {"seq":1}\n'));
  const ac = new AbortController();
  for (let n = 0; n < 20; n++) await api.streamEvents(0, () => {}, ac.signal);
  expect(getEventListeners(ac.signal, "abort").length).toBe(0);
});

test("consumer failure reconnects rather than masquerading as malformed JSON", async () => {
  const api = await client((res) => res.end('data: {"seq":1}\n'));
  await expect(
    api.streamEvents(
      0,
      () => {
        throw new Error("durable sink failed");
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("durable sink failed");
});

test("SSE connect and idle deadlines bound stalled peer", async () => {
  const api = await client(() => {});
  await expect(
    api.streamEvents(0, () => {}, new AbortController().signal),
  ).rejects.toThrow("deadline");
});
