// Headless latency probe for the familiar /pty bridge. Mirrors the browser
// probe in web/terminal.js: sends a printable token via the restty input
// protocol ({type:"input"}) and measures wall time until that token's bytes
// return on the pty OUTPUT stream (keystroke → echo). Reports p50/p95 over N.
//
// This measures the LOOPBACK baseline: browser ⇄ WS ⇄ node-pty ⇄ shell echo,
// minus the browser render step (a node ws client, not restty). The transport
// + coalescing delay it exercises is identical to the real page.
//
// Usage: node probe-smoke.mjs [ws://host:port/pty] [samples]
import { WebSocket } from "ws";

const url = process.argv[2] || "ws://127.0.0.1:1692/pty";
const SAMPLES = Number(process.argv[3] || 30);
const ws = new WebSocket(url);

const outputTaps = new Set();
let ready = false;

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
  // Let a shell prompt settle so echo is live.
  setTimeout(() => { ready = true; }, 400);
});
ws.on("message", (data, isBinary) => {
  if (!isBinary) return;
  const s = data.toString("utf8");
  for (const tap of outputTaps) tap(s);
});
ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pct(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
const send = (d) => ws.send(JSON.stringify({ type: "input", data: d }));

async function main() {
  while (!ready) await sleep(20);
  const times = [];
  for (let i = 0; i < SAMPLES; i++) {
    const token = `zfprobe${i}${Math.random().toString(36).slice(2, 6)}`;
    const dt = await new Promise((resolve) => {
      const t0 = performance.now();
      let done = false;
      const to = setTimeout(() => { if (!done) { done = true; outputTaps.delete(tap); resolve(NaN); } }, 2000);
      const tap = (s) => {
        if (done) return;
        if (s.includes(token)) { done = true; clearTimeout(to); outputTaps.delete(tap); resolve(performance.now() - t0); }
      };
      outputTaps.add(tap);
      send(token);
      // erase so the line is left clean
      send("\b".repeat(token.length) + " ".repeat(token.length) + "\b".repeat(token.length));
    });
    if (!Number.isNaN(dt)) times.push(dt);
    await sleep(40);
  }
  times.sort((a, b) => a - b);
  const r = {
    samples: times.length,
    p50: +pct(times, 50).toFixed(2),
    p95: +pct(times, 95).toFixed(2),
    min: +(times[0] ?? NaN).toFixed(2),
    max: +(times[times.length - 1] ?? NaN).toFixed(2),
    mean: +(times.reduce((a, b) => a + b, 0) / (times.length || 1)).toFixed(2),
  };
  console.log(JSON.stringify(r));
  try { ws.close(); } catch { /* ignore */ }
  process.exit(0);
}
main();
