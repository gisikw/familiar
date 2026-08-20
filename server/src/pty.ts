import type http from "http";
import { WebSocketServer, type WebSocket } from "ws";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { debugLog, errorLog } from "./debug.ts";

/* --- Browser terminal PTY bridge ------------------------------------------
 *
 * Bridges restty's built-in WebSocket PTY transport to a node-pty child that
 * ATTACHES to the already-running herdr session (never boots a second
 * familiar.sh). The attach command is FAMILIAR_ATTACH_CMD, defaulting to
 * `herdr session attach <FAMILIAR_ATTACH_SESSION|familiar>` — the same
 * invocation an external terminal would use. Set FAMILIAR_ATTACH_CMD to a
 * plain shell (e.g. `bash -l`) to smoke-test without herdr.
 *
 * restty PTY protocol (see restty dist/pty.d.ts):
 *   client → server : JSON text frames {type:"input",data} / {type:"resize",cols,rows}
 *   server → client : binary frames (raw pty output) + JSON {type:"status"|"exit"|"error"}
 * Output is sent as BINARY frames so the byte path is 8-bit clean; restty's
 * transport decodes binary via a streaming TextDecoder.
 */

function attachCommand(): { file: string; args: string[] } {
  const raw = process.env.FAMILIAR_ATTACH_CMD;
  if (raw && raw.trim()) {
    // Split on whitespace — attach invocations are simple argv, no quoting.
    const parts = raw.trim().split(/\s+/);
    return { file: parts[0], args: parts.slice(1) };
  }
  const session = process.env.FAMILIAR_ATTACH_SESSION || process.env.HERDR_SESSION || "familiar";
  return { file: "herdr", args: ["session", "attach", session] };
}

function startPty(cols: number, rows: number): IPty {
  const { file, args } = attachCommand();
  return ptySpawn(file, args, {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: process.env.FAMILIAR_ATTACH_CWD || process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  });
}

export class PtyBridge {
  private wss: WebSocketServer;

  constructor() {
    // noServer: we route the upgrade ourselves from the shared http.Server so
    // /pty coexists with the HTTP surface on the same port.
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  handleUpgrade(req: http.IncomingMessage, socket: any, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  private onConnection(ws: WebSocket) {
    let pty: IPty | null = null;
    let exited = false;

    const send = (obj: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    const start = (cols: number, rows: number) => {
      if (pty) return;
      try {
        pty = startPty(cols, rows);
      } catch (err) {
        errorLog("pty", { spawnError: String(err) });
        send({ type: "error", message: String(err) });
        try { ws.close(); } catch { /* ignore */ }
        return;
      }
      const { file } = attachCommand();
      send({ type: "status", shell: file });
      pty.onData((data) => {
        // Binary frame: byte-clean output path.
        if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, "utf8"));
      });
      pty.onExit(({ exitCode }) => {
        exited = true;
        send({ type: "exit", code: exitCode });
        try { ws.close(); } catch { /* ignore */ }
      });
    };

    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      // restty sends control as JSON text frames; treat binary as raw input.
      if (isBinary) {
        if (pty) pty.write(raw.toString("utf8"));
        return;
      }
      let msg: any;
      try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (msg?.type === "input") {
        if (!pty) start(80, 24); // first input implies a session; be lenient
        if (pty && typeof msg.data === "string") pty.write(msg.data);
      } else if (msg?.type === "resize") {
        const cols = Number(msg.cols) || 80;
        const rows = Number(msg.rows) || 24;
        if (!pty) start(cols, rows);
        else { try { pty.resize(Math.max(1, cols), Math.max(1, rows)); } catch { /* pty gone */ } }
      }
    });

    ws.on("close", () => {
      if (pty && !exited) { try { pty.kill(); } catch { /* already gone */ } }
    });
    ws.on("error", (err) => debugLog("pty", { wsError: String(err) }));

    // restty opens the socket then sends the first resize; but start lazily on
    // first control frame so we honor the client's real geometry.
  }

  close() {
    try { this.wss.close(); } catch { /* ignore */ }
  }
}
