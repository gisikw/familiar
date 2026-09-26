import { afterEach, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import scheduler, { deliveredIds, forkRequest, SCHEDULED_FORK } from "./index.ts";

const roots: string[] = [];
const savedPath = process.env.PATH;
const savedSocket = process.env.FAMILIAR_SERVICES_SOCKET;
afterEach(() => {
  process.env.PATH = savedPath;
  if (savedSocket === undefined) delete process.env.FAMILIAR_SERVICES_SOCKET; else process.env.FAMILIAR_SERVICES_SOCKET = savedSocket;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const forkEvent = { id: "brief-at-1", due_at: Date.UTC(2026, 8, 28, 11), target: "instance:p", origin: "p", source: "imp.schedule", priority: 2, type: "fork", summary: "Daily briefing", body: JSON.stringify({ task: "Daily briefing", label: "daily briefing" }), urgency: "wake" as const, state: "delivered", created_at: 0, rule: "day 06:00", series: "brief" };

test("forkRequest reads the JSON body and tolerates plain text", () => {
  expect(forkRequest(forkEvent)).toEqual({ task: "Daily briefing", label: "daily briefing" });
  expect(forkRequest({ ...forkEvent, body: "just do it" })).toEqual({ task: "just do it", label: "" });
});

test("a recorded scheduled fork counts as delivered", () => {
  expect([...deliveredIds([{ type: "custom", customType: SCHEDULED_FORK, data: { id: "brief-at-1" } }])]).toEqual(["brief-at-1"]);
});

test("a fork event waits for idle, spawns imp fork with origin and label, records it, and acks without a turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "sched-fork-"));
  roots.push(root);
  // A fake imp on PATH records its argv and prints a fork id.
  const argvFile = join(root, "argv.json");
  const imp = join(root, "imp");
  writeFileSync(imp, `#!/bin/sh\nprintf '%s\\0' "$@" > ${argvFile}\necho 01fork-id\n`);
  chmodSync(imp, 0o755);
  process.env.PATH = `${root}:${savedPath}`;

  const socketPath = join(root, "svc.sock");
  process.env.FAMILIAR_SERVICES_SOCKET = socketPath;
  let acked: string | undefined;
  let ackResolve!: () => void;
  const ackSeen = new Promise<void>((r) => { ackResolve = r; });
  const server = createServer((socket: Socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (msg.op === "hello") { socket.write(`${JSON.stringify({ ok: true, result: {} })}\n`); socket.write(`${JSON.stringify({ event: forkEvent })}\n`); }
        if (msg.op === "schedule.ack") { acked = msg.args.id; ackResolve(); }
      }
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));

  const handlers = new Map<string, Array<(e: any, ctx: any) => any>>();
  const entries: any[] = [];
  const sent: any[] = [];
  let idle = false;
  const pi = {
    on(name: string, h: any) { handlers.set(name, [...(handlers.get(name) ?? []), h]); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    sendMessage(message: any, options: any) { sent.push({ message, options }); },
  };
  scheduler(pi as any);
  const ctx = { sessionManager: { getSessionId: () => "p", getBranch: () => entries }, isIdle: () => idle };
  for (const h of handlers.get("session_start") ?? []) await h({}, ctx);

  await new Promise((r) => setTimeout(r, 150));
  expect(acked).toBeUndefined(); // busy: nothing spawned, nothing acked yet
  idle = true;
  for (const h of handlers.get("agent_settled") ?? []) await h({}, ctx);
  await ackSeen;

  const argv = readFileSync(argvFile, "utf8").split("\0").filter(Boolean);
  expect(argv.slice(0, 5)).toEqual(["fork", "--origin", "schedule:brief", "--label", "daily briefing"]);
  expect(argv[5]).toContain("Scheduled every day 06:00");
  expect(argv[5]).toEndWith("Daily briefing");
  expect(acked).toBe("brief-at-1");
  expect(entries).toEqual([{ type: "custom", customType: SCHEDULED_FORK, data: { id: "brief-at-1", forkId: "01fork-id", series: "brief", task: "Daily briefing" } }]);
  expect(sent).toHaveLength(1);
  expect(sent[0].options).toEqual({ deliverAs: "nextTurn" }); // quiet: no turn
  expect(sent[0].message.content).toStartWith("\n\nscheduled fork 01fork-id started (every day 06:00): daily briefing");

  for (const h of handlers.get("session_shutdown") ?? []) await h({}, ctx);
  await new Promise<void>((r) => server.close(() => r()));
});
