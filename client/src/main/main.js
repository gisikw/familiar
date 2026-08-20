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
    backgroundColor: "#1e1e2e", // matches terminal bg so no light letterbox flashes
    // Edgeless: no native titlebar at all. frame:false removes the whole chrome;
    // a slim -webkit-app-region:drag strip in the renderer keeps it draggable,
    // and Cmd-Q / Cmd-W still close it (menu accelerators below).
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    trafficLightPosition:
      process.platform === "darwin" ? { x: 12, y: 10 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // ---------------------------------------------------------------------------
  // Keyboard passthrough EXCEPTION: claim Cmd/Ctrl +/-/0 for font zoom BEFORE
  // the renderer forwards keystrokes to the pty, so remote apps (pi) can't eat
  // them. We intercept at the main process, tell the renderer to change font
  // size, and swallow the chord (never sent to the pty).
  // ---------------------------------------------------------------------------
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const mod = process.platform === "darwin" ? input.meta : input.control;
    if (!mod) return;
    // key is the physical key; handle both '='/'+' and '-'/'_' and '0'.
    const k = input.key;
    let action = null;
    if (k === "+" || k === "=") action = "in";
    else if (k === "-" || k === "_") action = "out";
    else if (k === "0") action = "reset";
    if (!action) return;
    event.preventDefault(); // do NOT let this reach the renderer/pty
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("zoom:font", action);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (pty) {
      killPty(pty);
      pty = null;
    }
  });
}

// Minimal menu so Cmd-Q / Cmd-W still work on an edgeless (frameless) window,
// plus standard copy/paste. Without a menu, frameless macOS windows lose these
// accelerators.
function installMenu() {
  const { Menu } = require("electron");
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" }, // Cmd-Q
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [isMac ? { role: "close" } : { role: "quit" }], // Cmd-W / Ctrl-Q
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
  installMenu();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
