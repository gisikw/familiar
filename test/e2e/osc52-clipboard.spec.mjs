import { createRequire } from 'node:module';

const { test, expect } = createRequire(import.meta.url)('@playwright/test');

// OSC 52 -> browser system clipboard bridge.
//
// HONESTY NOTE: Playwright grants clipboard permission to the test context, so
// this proves the served osc52.js module + the real Chromium Clipboard API +
// the real secure-context path deliver decoded text to the actual system
// clipboard (read back via navigator.clipboard.readText). It does NOT and
// cannot prove a real end-user permission grant or the OS clipboard UX — that
// requires transient user activation from a genuine gesture, which we exercise
// separately in unit tests and rely on the initiating pointerup for in
// production. We deliberately do not pretend a granted mock equals real
// permission.
test.describe.serial('osc52 clipboard bridge (real browser clipboard)', () => {
  let page;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    page = await context.newPage();
    await page.goto('/');
    // The served page is same-origin loopback (secure context in Chromium).
    expect(await page.evaluate(() => window.isSecureContext)).toBeTruthy();
  });

  test.afterAll(async () => { await page?.close(); });

  test('served parser decodes a viewer OSC 52 write and rejects reads', async () => {
    const result = await page.evaluate(async () => {
      const { Osc52Parser } = await import('/app/osc52.js');
      const p = new Osc52Parser();
      const b64 = btoa('clipboard-roundtrip');
      // Split across a boundary to exercise streaming reassembly in-browser.
      const seq = `\x1b]52;c;${b64}\x07`;
      const a = p.feed(seq.slice(0, 6));
      const b = p.feed(seq.slice(6));
      const reads = p.feed('\x1b]52;c;?\x07');
      return { copied: [...a, ...b], reads };
    });
    expect(result.copied).toEqual(['clipboard-roundtrip']);
    expect(result.reads).toEqual([]);
  });

  test('writeSystemClipboard writes real text to the system clipboard', async () => {
    const readBack = await page.evaluate(async () => {
      const { writeSystemClipboard } = await import('/app/osc52.js');
      const text = `osc52-e2e-${Date.now()}`;
      const method = await writeSystemClipboard(text);
      const back = await navigator.clipboard.readText();
      return { text, method, back };
    });
    expect(readBack.method).toBe('async');
    expect(readBack.back).toBe(readBack.text);
  });

  test('full bridge feed copies a viewer sequence to the system clipboard', async () => {
    const readBack = await page.evaluate(async () => {
      const { createOsc52Bridge } = await import('/app/osc52.js');
      const marker = `bridge-${Date.now()}`;
      const done = new Promise((resolve, reject) => {
        const feed = createOsc52Bridge({ onCopied: resolve, onFailed: reject });
        feed(`\x1b]52;c;${btoa(marker)}\x07`);
      });
      const info = await done;
      const back = await navigator.clipboard.readText();
      return { marker, info, back };
    });
    expect(readBack.info.method).toBe('async');
    expect(readBack.info.chars).toBe(readBack.marker.length);
    expect(readBack.back).toBe(readBack.marker);
  });
});
