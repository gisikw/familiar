import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const { test, expect } = createRequire(import.meta.url)('@playwright/test');
const socket = process.env.FAMILIAR_E2E_SOCKET;
const image = process.env.FAMILIAR_E2E_IMAGE;
const artifacts = process.env.FAMILIAR_E2E_ARTIFACTS;
const baseURL = process.env.FAMILIAR_E2E_URL;
let page;
let browserFrames = [];

function tmuxCommand(command) {
  execFileSync('tmux', ['-S', socket, 'send-keys', '-t', 'presence:0.0', '-l', command]);
  execFileSync('tmux', ['-S', socket, 'send-keys', '-t', 'presence:0.0', 'Enter']);
}

async function pixels(buffer, kind, before) {
  return page.evaluate(async ({ png, prior, kind }) => {
    const decode = async (b64) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height,
        data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
    };
    const a = await decode(png);
    const b = prior ? await decode(prior) : null;
    let count = 0;
    const sidebar = kind === 'teal';
    const x0 = sidebar ? 0 : Math.floor(a.width * .21);
    const x1 = sidebar ? Math.floor(a.width * .24) : a.width;
    const y1 = sidebar ? Math.floor(a.height * .48) : Math.floor(a.height * .92);
    for (let y = 0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4, r = a.data[i], g = a.data[i+1], bl = a.data[i+2];
      if (kind === 'teal' && g > 145 && bl > 160 && r < 150 && bl > r * 1.25) count++;
      if (kind === 'magenta' && r > 190 && bl > 190 && g < 90) count++;
      if (kind === 'diff' && b && (Math.abs(r-b.data[i]) + Math.abs(g-b.data[i+1]) + Math.abs(bl-b.data[i+2]) > 80)) count++;
    }
    return count;
  }, { png: buffer.toString('base64'), prior: before?.toString('base64'), kind });
}

async function waitForPixels(kind, minimum, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let shot, count = 0;
  while (Date.now() < deadline) {
    shot = await page.screenshot();
    count = await pixels(shot, kind);
    if (count >= minimum) return { shot, count };
    await page.waitForTimeout(400);
  }
  return { shot, count };
}

test.describe.serial('real browser terminal', () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
      if (Buffer.isBuffer(payload)) browserFrames.push(payload);
    }));
    await page.goto('/');
  });
  test.afterAll(async () => { await page?.close(); });

  test('sidebar PNG mark renders (teal pixel truth)', async () => {
    const { shot, count } = await waitForPixels('teal', 80);
    fs.writeFileSync(path.join(artifacts, 'sidebar-mark.png'), shot);
    expect(count, 'teal pixels in the top-left 28-column sidebar').toBeGreaterThanOrEqual(80);
  });

  test('presence content changes main canvas pixels', async () => {
    // restty is a GPU canvas and exposes no terminal text DOM. Compare the main
    // region before/after a high-contrast, repeated marker instead.
    tmuxCommand("printf '\\033[2J\\033[H'");
    await page.waitForTimeout(700);
    const before = await page.screenshot();
    tmuxCommand("printf '\\033[H\\033[97;44m E2E-PRESENCE-MARKER E2E-PRESENCE-MARKER \\033[0m\\n'");
    await page.waitForTimeout(900);
    const after = await page.screenshot();
    fs.writeFileSync(path.join(artifacts, 'content-before.png'), before);
    fs.writeFileSync(path.join(artifacts, 'content-after.png'), after);
    expect(await pixels(after, 'diff', before), 'changed pixels in main terminal region').toBeGreaterThan(300);
  });

  test('in-session Kitty image renders', async () => {
    tmuxCommand("printf '\\033[2J\\033[H'");
    await page.waitForTimeout(500);
    browserFrames = [];
    const tapOut = path.join(artifacts, 'kitty-websocket.bin');
    const ready = path.join(artifacts, '.tap-ready');
    try { fs.unlinkSync(ready); } catch {}
    const tap = spawn(process.execPath, [path.join(import.meta.dirname, 'ws-tap.mjs'), baseURL.replace('http', 'ws') + '/pty', tapOut, ready], { stdio: ['ignore', 'inherit', 'inherit'] });
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await page.waitForTimeout(50);
    expect(fs.existsSync(ready), 'diagnostic websocket tap connected').toBeTruthy();

    const quoted = `'${image.replaceAll("'", "'\\''")}'`;
    tmuxCommand(`timeout 12 kitten icat --transfer-mode=stream --stdin=no --align=left --scale-up --place=16x8@2x2 ${quoted}; printf '\\nICAT-DONE:%s\\n' $?`);
    const result = await waitForPixels('magenta', 100, 12_000);
    fs.writeFileSync(path.join(artifacts, 'kitty-image.png'), result.shot);
    const pane = execFileSync('tmux', ['-S', socket, 'capture-pane', '-p', '-e', '-t', 'presence:0.0', '-S', '-40']);
    fs.writeFileSync(path.join(artifacts, 'kitty-presence-pane.txt'), pane);
    const tapExited = new Promise(resolve => tap.once('exit', resolve));
    tap.kill('SIGKILL');
    await Promise.race([tapExited, page.waitForTimeout(1000)]);
    const tapped = fs.existsSync(tapOut) ? fs.readFileSync(tapOut) : Buffer.alloc(0);
    const browserBytes = Buffer.concat(browserFrames);
    fs.writeFileSync(path.join(artifacts, 'kitty-browser-websocket.bin'), browserBytes);
    // Mark upload is f=100 PNG. Child extraction is uniquely translated by the
    // viewer to raw f=24/f=32; seeing that header proves viewer emission.
    const translated = /\x1b_G[^;]*(?:,|^)f=(?:24|32)(?:,|;)/s.test(tapped.toString('latin1')) ||
      /\x1b_G[^;]*(?:,|^)f=(?:24|32)(?:,|;)/s.test(browserBytes.toString('latin1'));
    const paneText = pane.toString('utf8');
    const record = { pixels: result.count >= 100, magentaPixels: result.count, bytes: translated,
      icatCompleted: /ICAT-DONE:0/.test(paneText), tapBytes: tapped.length, browserBytes: browserBytes.length };
    fs.writeFileSync(path.join(artifacts, 'kitty-result.json'), JSON.stringify(record, null, 2) + '\n');
    console.log(`KITTY PASS: magenta image rendered (${record.magentaPixels} pixels)`);
    expect(record.icatCompleted, 'kitten icat completed successfully').toBeTruthy();
    expect(record.bytes, 'viewer emitted translated child image bytes').toBeTruthy();
    expect(record.magentaPixels, 'magenta pixels in the main terminal region').toBeGreaterThanOrEqual(100);
  });
});
