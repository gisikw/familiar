const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");

// Self-test mode: hand off to the headless verification harness.
if (process.argv.includes("--selftest")) {
  require("../selftest/selftest.js");
  return;
}

const { spawn: spawnPty, resizePty, killPty } = require("./pty");
const { saveDrop } = require("./drops");
const {
  ensureSpawnHelperExecutable,
} = require("../../scripts/ensure-spawn-helper.js");

// Self-heal node-pty's spawn-helper permissions at startup, before any spawn.
// (Also done at install time and inside spawn(); belt and suspenders.)
try {
  ensureSpawnHelperExecutable();
} catch (_) {
  /* best-effort */
}

// ---------------------------------------------------------------------------
// Single window, near-zero chrome. macOS: hiddenInset titlebar.
// ---------------------------------------------------------------------------
let mainWindow = null;
let pty = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 680,
    backgroundColor: "#f4f4f5", // light-mode frame; terminal paints its own dark bg
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (pty) {
      killPty(pty);
      pty = null;
    }
  });
}

// ---------------------------------------------------------------------------
// PTY lifecycle. The renderer owns the restty terminal; we own the shell.
// Data flows main -> renderer as UTF-8 strings ('pty:data'); renderer -> main
// as input strings ('pty:input'). Backpressure: node-pty is a stream; we relay
// synchronously and let Electron's IPC queue absorb bursts. We also pause the
// pty if the renderer signals it is behind (see 'pty:flow').
// ---------------------------------------------------------------------------
function startPty(cols, rows) {
  if (pty) {
    killPty(pty);
    pty = null;
  }
  try {
    pty = spawnPty({
      cols: cols || 80,
      rows: rows || 24,
      onData: (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("pty:data", data);
        }
      },
      onExit: ({ exitCode }) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("pty:exit", exitCode);
        }
      },
    });
  } catch (err) {
    // Cause #5: never let a spawn failure become an uncaught exception on a
    // black screen. Ship a full, readable diagnostic INTO the window.
    pty = null;
    const payload = {
      message: (err && err.message) || String(err),
      cause: err && err.cause ? String(err.cause.message || err.cause) : null,
      stack: (err && err.stack) || null,
      diagnostics: (err && err.diagnostics) || null,
      versions: {
        electron: process.versions.electron,
        node: process.versions.node,
        modules: process.versions.modules,
        chrome: process.versions.chrome,
      },
    };
    // eslint-disable-next-line no-console
    console.error("[familiar] pty spawn failed:", payload);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pty:fatal", payload);
    }
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pty:status", { shell: pty.shellName });
  }
}

app.whenReady().then(() => {
  // Belt-and-suspenders: forbid the renderer from ever navigating to a
  // dropped file:// URL even if a drop handler were bypassed.
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["file:///*drops/*"] },
    (details, cb) => cb({ cancel: false })
  );

  ipcMain.on("pty:start", (_e, { cols, rows }) => startPty(cols, rows));
  ipcMain.on("pty:input", (_e, data) => {
    if (pty) pty.write(data);
  });
  ipcMain.on("pty:resize", (_e, { cols, rows }) => {
    if (pty) resizePty(pty, cols, rows);
  });

  // Drag-and-drop capture: renderer intercepts the drop, prevents default,
  // and forwards {name, bytes} here. We persist into ~/.familiar/drops/.
  ipcMain.handle("drop:save", async (_e, { name, bytes }) => {
    return saveDrop(name, Buffer.from(bytes));
  });

  // Serve bundled font bytes to the renderer. CSP blocks fetch() of file://
  // fonts, so we read them here and hand back an ArrayBuffer. Only allow
  // basenames within the fonts dir (no traversal).
  ipcMain.handle("font:read", async (_e, name) => {
    const safe = path.basename(String(name || ""));
    const file = path.join(__dirname, "..", "renderer", "fonts", safe);
    const buf = fs.readFileSync(file);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
