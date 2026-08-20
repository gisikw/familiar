#!/usr/bin/env node
// mcp-stub.ts — extension-owned stdio MCP server. Its ONLY job is to make pi's
// tools VISIBLE to headless claude (tools/list) and to TERMINATE the turn when
// claude calls one (tools/call). No placeholder replacement, no held state.
//
// Contract (RESEARCH §3.4): speaks newline-delimited JSON-RPC over stdio.
//   initialize            → echo claude's protocolVersion + tools capability
//   notifications/initialized → (no reply)
//   tools/list            → the pi tool definitions passed via MCP_STUB_TOOLS
//   tools/call            → return a stub result, RECORD the call to
//                           MCP_STUB_CAPTURE, then SIGTERM the parent (claude)
//                           so `claude -p` exits. The orchestrator has already
//                           read the real tool_use SSE from claude's stdout and
//                           returns it to pi; pi's NEXT request carries the real
//                           tool_result (freshly projected). Nothing is held.
//
// Env:
//   MCP_STUB_TOOLS    JSON array of {name,description,inputSchema}
//   MCP_STUB_CAPTURE  path to write the captured tools/call as JSON (atomic-ish)
//   MCP_STUB_LOG      optional debug log path
import * as fs from "node:fs";

const TOOLS: unknown[] = JSON.parse(process.env.MCP_STUB_TOOLS || "[]");
const CAPTURE = process.env.MCP_STUB_CAPTURE || "";
const LOG = process.env.MCP_STUB_LOG || "";

function logf(m: string): void {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, `${Date.now()} ${m}\n`); } catch {}
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let buf = "";
process.stdin.on("data", (c: Buffer) => {
  buf += c.toString("utf8");
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(line.trim());
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(line: string): void {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  switch (msg.method) {
    case "initialize": {
      const pv = msg.params?.protocolVersion || "2025-11-25";
      logf("initialize pv=" + pv);
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: pv,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "pi-mcp-stub", version: "0.1.0" },
        },
      });
      break;
    }
    case "notifications/initialized":
      break;
    case "tools/list":
      logf("tools/list count=" + TOOLS.length);
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
      break;
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      const meta = msg.params?._meta ?? {};
      const toolUseId = meta["claudecode/toolUseId"] ?? "";
      logf(`tools/call name=${name} toolUseId=${toolUseId}`);
      if (CAPTURE) {
        try {
          fs.writeFileSync(CAPTURE, JSON.stringify({ name, arguments: args, toolUseId }));
        } catch (e) { logf("capture-err " + e); }
      }
      // Stub result — the real result comes from pi next turn.
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: "pi captured this tool call; the real result will be supplied next turn." }],
          isError: false,
        },
      });
      // Terminate the turn: SIGTERM the parent claude. Small delay so the JSON
      // response flushes down the pipe before claude dies.
      const ppid = process.ppid;
      logf("SIGTERM parent=" + ppid);
      setTimeout(() => {
        try { process.kill(ppid, "SIGTERM"); } catch (e) { logf("kill-err " + e); }
        process.exit(0);
      }, 30);
      break;
    }
    default:
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
