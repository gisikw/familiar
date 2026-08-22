import type http from "http";
import { WebSocketServer, type WebSocket } from "ws";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { fileURLToPath } from "url";
import { debugLog, errorLog } from "./debug.ts";

/* --- Browser terminal PTY bridge ------------------------------------------
 *
 * Bridges restty's built-in WebSocket PTY transport to a node-pty child that
 * ATTACHES to the Viewer session on the Presence Runtime's private tmux
 * server. Viewer's main pane nests the resident Presence session; Herdr is not
 * in this lifecycle path. FAMILIAR_ATTACH_CMD remains a test override.
 *
 * restty PTY protocol (see restty dist/pty.d.ts):
 *   client → server : JSON text frames {type:"input",data} / {type:"resize",cols,rows}
 *   server → client : binary frames (raw pty output) + JSON {type:"status"|"exit"|"error"}
 * Output is sent as BINARY frames so the byte path is 8-bit clean; restty's
 * transport decodes binary via a streaming TextDecoder.
 *
 * OUTPUT COALESCING: node-pty emits many small chunks during a redraw (a TUI
 * repaint can be dozens of onData calls in one event-loop tick). Each WS frame
 * has fixed per-message overhead (framing + a JS event + a TextDecoder call +
 * a paint schedule on the client). We coalesce chunks that arrive in the SAME
 * tick and flush once via setImmediate — this merges bursts/redraws into one
 * larger binary frame while adding ~0ms latency to an isolated keystroke echo
 * (a single chunk still goes out this same tick). Measured on loopback, a
 * fixed flush *timer* instead adds its full interval to keystroke echo
 * (~6ms at FLUSH_MS=6 vs ~0.9ms with setImmediate), so setImmediate is the
 * default. Set FAMILIAR_PTY_FLUSH_MS>0 to force time-window batching (heavier
 * coalescing, higher echo latency); =0/unset uses setImmediate coalescing.
 * Because restty's decoder is a *streaming* TextDecoder, splitting/merging on
 * arbitrary byte boundaries is safe (a multi-byte UTF-8 sequence spanning
 * frames is still reassembled correctly).
 */

// >0: time-window batching via setTimeout(ms). <=0/unset: same-tick coalescing
// via setImmediate (near-zero added latency, still merges redraw bursts).
const FLUSH_MS = Number(process.env.FAMILIAR_PTY_FLUSH_MS ?? 0);

export function attachCommand(): { file: string; args: string[] } {
  const raw = process.env.FAMILIAR_ATTACH_CMD;
  if (raw && raw.trim()) {
    // Split on whitespace — attach invocations are simple argv, no quoting.
    const parts = raw.trim().split(/\s+/);
    return { file: parts[0], args: parts.slice(1) };
  }
  const controller = process.env.FAMILIAR_PRESENCE_CTL
    || fileURLToPath(new URL("../../presence/presence.sh", import.meta.url));
  return { file: controller, args: ["viewer"] };
}

function startPty(cols: number, rows: number): IPty {
  const { file, args } = attachCommand();
  // Preserve Familiar/Herdr context. The child is the Presence adapter (not a
  // nested Herdr client), and a cold-started pi may need the current workspace
  // identity for bounded compatibility with Herdr-backed extensions.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Also drop outer-context markers that herdr's client uses to DECIDE the
    // outer terminal is a multiplexer/remote where it should NOT assume kitty
    // graphics capability (herdr src/client/mod.rs reads SSH_CONNECTION /
    // SSH_TTY / STY alongside the positive TERM_PROGRAM / KITTY_WINDOW_ID
    // signals). The server itself is reached over SSH, so these are present in
    // our own env and would otherwise leak into the attach child and defeat the
    // KITTY_WINDOW_ID/TERM_PROGRAM signals we set below. The browser is a
    // direct, local-feeling window onto the pty, so present it that way.
    if (k === "SSH_CONNECTION" || k === "SSH_TTY" || k === "SSH_CLIENT" || k === "STY") continue;
    env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  // The surface beyond this pty is restty, which implements kitty graphics.
  env.TERM_PROGRAM = process.env.FAMILIAR_ATTACH_TERM_PROGRAM || "ghostty";
  env.KITTY_WINDOW_ID = process.env.FAMILIAR_ATTACH_KITTY_WINDOW_ID || "1";
  return ptySpawn(file, args, {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: process.env.FAMILIAR_ATTACH_CWD || process.cwd(),
    env,
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
    // Disable Nagle on the raw TCP socket before ws wraps it. SSH clients set
    // TCP_NODELAY for exactly this workload (interactive keystroke echo); Node
    // sockets default to Nagle ON, which holds small writes hoping to batch
    // more and — interacting with delayed ACKs — can add tens of ms per echo.
    // This is the main feel difference vs the ssh-based Electron path.
    socket.setNoDelay?.(true);
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

      // Coalescing buffer: accumulate pty chunks, flush as one binary frame.
      let pending: Buffer[] = [];
      let flushTimer: NodeJS.Timeout | null = null;
      let flushImmediate: NodeJS.Immediate | null = null;
      const flush = () => {
        flushTimer = null;
        flushImmediate = null;
        if (!pending.length) return;
        const frame = pending.length === 1 ? pending[0] : Buffer.concat(pending);
        pending = [];
        if (ws.readyState === ws.OPEN) ws.send(frame);
      };
      const enqueue = (buf: Buffer) => {
        if (ws.readyState !== ws.OPEN) return;
        pending.push(buf);
        if (FLUSH_MS > 0) {
          // Time-window batching: wait up to FLUSH_MS to accumulate.
          if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
        } else if (!flushImmediate) {
          // Same-tick coalescing: merge everything emitted this tick, flush
          // after the current I/O callbacks drain. Near-zero added latency.
          flushImmediate = setImmediate(flush);
        }
      };
      const cancelFlush = () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (flushImmediate) { clearImmediate(flushImmediate); flushImmediate = null; }
      };

      pty.onData((data) => {
        // Binary frame: byte-clean output path (coalesced).
        enqueue(Buffer.from(data, "utf8"));
      });
      pty.onExit(({ exitCode }) => {
        exited = true;
        cancelFlush();
        flush(); // drain any buffered output before the exit notice
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
