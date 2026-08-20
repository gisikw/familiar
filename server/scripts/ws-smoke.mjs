// WS PTY bridge smoke test. Connects to the server's /pty using restty's
// protocol, drives a shell, and asserts we see our echoed marker back as a
// binary output frame. Exits 0 on success.
import { WebSocket } from "ws";

const url = process.argv[2] || "ws://127.0.0.1:1692/pty";
const MARKER = `PTYSMOKE_${Math.random().toString(36).slice(2)}`;
const ws = new WebSocket(url);
let got = "";
let done = false;

const finish = (code, msg) => {
  if (done) return;
  done = true;
  if (msg) process.stderr.write(msg + "\n");
  try { ws.close(); } catch { /* ignore */ }
  process.exit(code);
};

const timer = setTimeout(() => finish(1, "timeout waiting for pty echo"), 6000);

ws.on("open", () => {
  // restty protocol: JSON text control frames.
  ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
  ws.send(JSON.stringify({ type: "input", data: `echo ${MARKER}\n` }));
});

ws.on("message", (data, isBinary) => {
  // Output arrives as binary frames; status/exit as JSON text.
  const s = data.toString("utf8");
  if (isBinary) {
    got += s;
    if (got.includes(MARKER)) { clearTimeout(timer); finish(0, "saw marker"); }
  }
});

ws.on("error", (err) => finish(1, "ws error: " + err.message));
ws.on("close", () => { if (!done) finish(got.includes(MARKER) ? 0 : 1, "closed"); });
