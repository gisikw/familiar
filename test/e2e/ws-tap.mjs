// Independent restty-protocol client. It persists raw viewer PTY output as each
// frame arrives, so even forced teardown retains diagnostic evidence.
import fs from 'node:fs';

const [url, output, ready] = process.argv.slice(2);
if (!url || !output || !ready) process.exit(2);
fs.writeFileSync(output, Buffer.alloc(0));
const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'resize', cols: 140, rows: 40 }));
  // A raw client must answer crossterm's startup CPR (the browser app has its
  // own TerminalReplyGate). Repeat to avoid racing the viewer's first query.
  for (const delay of [40, 150, 400]) setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'input', data: '\u001b[1;1R' }));
  }, delay);
  fs.writeFileSync(ready, 'ready\n');
});
ws.addEventListener('message', async ({ data }) => {
  if (typeof data === 'string') return;
  if (data instanceof ArrayBuffer) fs.appendFileSync(output, Buffer.from(data));
  else if (data?.arrayBuffer) fs.appendFileSync(output, Buffer.from(await data.arrayBuffer()));
});
ws.addEventListener('error', (event) => console.error('ws tap error', event.message || event.type));
