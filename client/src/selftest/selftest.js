// Headless self-test harness. Launched via `electron . --selftest`.
// It boots the app, waits for the shell prompt, sends `echo FAMILIAR_OK`,
// simulates a file drop, verifies ~/.familiar/drops/ received a copy, writes a
// screenshot, and exits 0/1. Used for CI-style verification on a headless box.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");

const DROPS_DIR = path.join(os.homedir(), ".familiar", "drops");
const OUT = path.join(os.tmpdir(), "familiar-selftest");
fs.mkdirSync(OUT, { recursive: true });

let ptyOutput = "";

function log(...a) {
  // eslint-disable-next-line no-console
  console.log("[selftest]", ...a);
}

function fail(msg) {
  log("FAIL:", msg);
  app.exit(1);
}

function pass() {
  log("PASS");
  app.exit(0);
}

async function run() {
  const { spawn, resizePty, killPty } = require("../main/pty");
  const {
    resolveShell,
    resolveCwd,
    sanitizeEnv,
    ensureSpawnHelperExecutable,
  } = require("../main/pty");
  const { saveDrop } = require("../main/drops");

  // 0. Robustness helpers (macOS posix_spawnp hardening).
  const helper = ensureSpawnHelperExecutable();
  log("spawn-helper check:", JSON.stringify(helper));
  const rShell = resolveShell();
  if (!require("fs").existsSync(rShell) && rShell !== "/bin/sh") {
    return fail("resolveShell returned a nonexistent path: " + rShell);
  }
  log("resolveShell:", rShell);
  const rCwd = resolveCwd();
  if (!require("fs").existsSync(rCwd)) return fail("resolveCwd nonexistent: " + rCwd);
  log("resolveCwd:", rCwd);

  // 0b. Revision assets: fonts present + emoji map parses.
  const rroot = path.join(__dirname, "..", "renderer");
  for (const f of [
    "fonts/ProggyCleanNerdFontMono-Regular.ttf",
    "fonts/JetBrainsMono-Regular.ttf",
    "fonts/OpenMoji-black-glyf.ttf",
    "vendor/emoji.json",
  ]) {
    if (!fs.existsSync(path.join(rroot, f))) return fail("missing asset: " + f);
  }
  const emojiMap = JSON.parse(
    fs.readFileSync(path.join(rroot, "vendor", "emoji.json"), "utf8")
  );
  if (!emojiMap.rocket || emojiMap.rocket !== "🚀")
    return fail("emoji map bad (rocket)");
  log("assets OK: proggy font + jetbrains + openmoji cmap + emoji(" + Object.keys(emojiMap).length + ")");
  const sEnv = sanitizeEnv({
    ...process.env,
    NIX_STORE: "/nix/store",
    NIX_CFLAGS: "x",
    IN_NIX_SHELL: "impure",
    PATH: "/nix/store/abc/bin:/usr/bin:/bin",
  });
  if (sEnv.NIX_STORE || sEnv.NIX_CFLAGS || sEnv.IN_NIX_SHELL) {
    return fail("sanitizeEnv left nix vars behind");
  }
  if (/\/nix\/store/.test(sEnv.PATH)) return fail("sanitizeEnv left /nix/store in PATH");
  log("sanitizeEnv OK, PATH:", sEnv.PATH);

  // 1. PTY spins up and echoes.
  let pty;
  await new Promise((resolve) => {
    pty = spawn({
      cols: 80,
      rows: 24,
      onData: (d) => {
        ptyOutput += d;
      },
      onExit: () => {},
    });
    setTimeout(resolve, 800);
  });
  log("shell:", pty.shellName);

  pty.write("echo FAMILIAR_OK_$((6*7))\n");
  await new Promise((r) => setTimeout(r, 1200));

  if (!/FAMILIAR_OK_42/.test(ptyOutput)) {
    killPty(pty);
    return fail("pty did not echo expected output. Got:\n" + ptyOutput.slice(-400));
  }
  log("pty echo OK");

  // 2. Resize does not throw.
  resizePty(pty, 120, 40);
  log("resize OK");
  killPty(pty);

  // 3. Drop persistence: save a fake screenshot and confirm bytes landed.
  const bytes = Buffer.from("\x89PNG\r\n\x1a\nFAMILIAR-TEST-BYTES");
  const res = saveDrop("screenshot.png", bytes);
  if (!fs.existsSync(res.saved)) return fail("drop file not written: " + res.saved);
  const back = fs.readFileSync(res.saved);
  if (!back.equals(bytes)) return fail("drop bytes mismatch");
  if (!res.saved.startsWith(DROPS_DIR)) return fail("drop not under drops dir");
  log("drop persisted OK ->", res.saved);

  // 4. Render smoke test: load the real renderer in a window and screenshot.
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // The renderer will call pty:start etc.; wire minimal handlers so it boots.
  let livePty = null;
  ipcMain.on("pty:start", (_e, { cols, rows }) => {
    livePty = spawn({
      cols,
      rows,
      onData: (d) => win.webContents.send("pty:data", d),
      onExit: (c) => win.webContents.send("pty:exit", c.exitCode),
    });
    win.webContents.send("pty:status", { shell: livePty.shellName });
  });
  ipcMain.on("pty:input", (_e, d) => livePty && livePty.write(d));
  ipcMain.on("pty:resize", (_e, { cols, rows }) => livePty && resizePty(livePty, cols, rows));
  ipcMain.handle("drop:save", async (_e, { name, b }) => saveDrop(name, Buffer.from(b || [])));
  ipcMain.handle("font:read", async (_e, name) => {
    const file = path.join(__dirname, "..", "renderer", "fonts", path.basename(name));
    const buf = fs.readFileSync(file);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await new Promise((r) => setTimeout(r, 2500));

  // Send a visible command through the live terminal and capture.
  if (livePty) livePty.write("echo RENDERED && ls\n");
  await new Promise((r) => setTimeout(r, 1500));

  const img = await win.webContents.capturePage();
  const shot = path.join(OUT, "render.png");
  fs.writeFileSync(shot, img.toPNG());
  log("screenshot written ->", shot, `(${img.getSize().width}x${img.getSize().height})`);

  // Pull the backend restty selected (webgpu/webgl2) for the record.
  try {
    const backend = await win.webContents.executeJavaScript(
      "window.__familiarBackend || 'unknown'"
    );
    log("restty backend:", backend);
  } catch (_) {}

  if (livePty) killPty(livePty);
  pass();
}

app.whenReady().then(() =>
  run().catch((e) => fail("exception: " + (e && e.stack ? e.stack : e)))
);
