const { app, BrowserWindow, ipcMain, session, Menu, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");

// App icon. The master lives at repo-root assets/; a rasterized PNG set is
// checked in beside it. Since this app runs via `npm start` (not a packaged
// build), we set the dock icon at runtime on macOS and pass a PNG to
// BrowserWindow for Linux/Windows. Packaged builds instead use
// build/icon.icns via electron-builder (see package.json build.mac.icon).
const ICON_DIR = path.join(__dirname, "..", "..", "..", "assets", "icons");
function iconPng(size) {
  const p = path.join(ICON_DIR, `icon_${size}.png`);
  return fs.existsSync(p) ? p : null;
}

// Self-test mode: hand off to the headless verification harness.
if (process.argv.includes("--selftest")) {
  require("../selftest/selftest.js");
  return;
}

const { resolveBaseUrl, readConfigFile, writeConfigFile } = require("./config");

// ---------------------------------------------------------------------------
// Familiar is a DUMB CLIENT: a thin, near-chromeless Electron window that loads
// the terminal PAGE served by the configured familiar server (localhost by
// default, root "/"). The served page owns EVERYTHING — restty, the pty
// WebSocket, mouse/emoji handling, and drag-and-drop upload. Electron contributes
// only native chrome: an edgeless window, zoom chords, a persistent login session
// (so an authentication cookie survives restarts), and an offline retry page.
//
// A persistent session partition means browser-based authentication "just
// works": redirects complete inline and the resulting cookie is stored on disk
// under the partition.
// ---------------------------------------------------------------------------

// Persistent partition -> cookies (incl. the auth session) survive restarts.
const PARTITION = "persist:familiar";
const OFFLINE_PAGE = path.join(__dirname, "offline.html");

let mainWindow = null;
let settingsWindow = null;
let baseUrl = null;

// Reconnect backoff state for the "server unreachable" path.
let retryTimer = null;
let retryDelay = 0;
const RETRY_MIN = 1000;
const RETRY_MAX = 30000;

function clearRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry() {
  clearRetry();
  retryDelay = retryDelay ? Math.min(RETRY_MAX, retryDelay * 2) : RETRY_MIN;
  retryTimer = setTimeout(() => loadApp(), retryDelay);
}

// Load the served terminal page. On failure, swap in the local offline page
// (which auto-retries); success resets the backoff.
function loadApp() {
  clearRetry();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadURL(baseUrl).catch((err) => {
    showOffline(err && (err.message || String(err)));
  });
}

function showOffline(detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const q = new URLSearchParams({
    url: baseUrl || "",
    err: detail || "load failed",
  }).toString();
  mainWindow
    .loadFile(OFFLINE_PAGE, { search: q })
    .catch(() => {
      /* offline page is bundled; this should never fail */
    });
  scheduleRetry();
}

function persistBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const b = mainWindow.getBounds();
    writeConfigFile(app, { bounds: b });
  } catch (_) {
    /* best-effort */
  }
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 520,
    height: 260,
    resizable: false,
    parent: mainWindow || undefined,
    modal: !!mainWindow,
    title: "Familiar Server",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  settingsWindow.on("closed", () => { settingsWindow = null; });
}

function createWindow() {
  const cfg = readConfigFile(app);
  const bounds = cfg.bounds || {};

  mainWindow = new BrowserWindow({
    width: bounds.width || 1024,
    height: bounds.height || 680,
    x: Number.isInteger(bounds.x) ? bounds.x : undefined,
    y: Number.isInteger(bounds.y) ? bounds.y : undefined,
    icon: iconPng(512) || undefined, // Linux/Windows window + taskbar icon
    backgroundColor: "#282828", // static mirror: terminal bg, avoiding a light flash
    // Edgeless: no native titlebar. The served page (and our offline page) each
    // carry a slim -webkit-app-region:drag strip so the window stays draggable.
    frame: false,
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    trafficLightPosition:
      process.platform === "darwin" ? { x: 12, y: 10 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      partition: PARTITION, // persistent -> auth cookie survives restarts
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // ---------------------------------------------------------------------------
  // Zoom chords. The page is a real web document now, so Cmd/Ctrl +/-/0 map to
  // webContents zoom. We intercept BEFORE the keystroke reaches the page (so a
  // remote TUI can't eat it) and swallow it.
  // ---------------------------------------------------------------------------
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const mod = process.platform === "darwin" ? input.meta : input.control;
    if (!mod) return;
    const k = input.key;
    const wc = mainWindow.webContents;
    let handled = true;
    if (k === "+" || k === "=") wc.setZoomLevel(wc.getZoomLevel() + 0.5);
    else if (k === "-" || k === "_") wc.setZoomLevel(wc.getZoomLevel() - 0.5);
    else if (k === "0") wc.setZoomLevel(0);
    else handled = false;
    if (handled) event.preventDefault();
  });

  // Server unreachable / TLS / DNS failure -> offline page + backoff retry.
  // (-3 == ERR_ABORTED, fired for in-page nav we caused; ignore it.)
  mainWindow.webContents.on(
    "did-fail-load",
    (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (errorCode === -3) return;
      // Don't loop if the offline page itself is what failed.
      if (validatedURL && validatedURL.startsWith("file:")) return;
      showOffline(`${errorDesc} (${errorCode})`);
    }
  );

  // Successful load of the real app -> reset backoff.
  mainWindow.webContents.on("did-finish-load", () => {
    const url = mainWindow.webContents.getURL();
    if (url && !url.startsWith("file:")) retryDelay = 0;
  });

  // Open target=_blank / window.open in the same window rather than spawning
  // chrome-less popups (keeps the shell "single window").
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  mainWindow.on("resize", persistBounds);
  mainWindow.on("move", persistBounds);
  mainWindow.on("close", persistBounds);
  mainWindow.on("closed", () => {
    clearRetry();
    mainWindow = null;
  });

  loadApp();
}

// Minimal menu so Cmd-Q / Cmd-W and copy/paste still work on a frameless
// window (macOS drops these accelerators without a menu). Zoom items give a
// menu-driven path in addition to the before-input-event chords.
function installMenu() {
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
              { label: "Configure Server URL…", click: openSettings },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [isMac ? { role: "close" } : { role: "quit" }],
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
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  baseUrl = resolveBaseUrl(app);
  // eslint-disable-next-line no-console
  console.log("[familiar] base URL:", baseUrl, "partition:", PARTITION);

  // Renderer (offline page) can ask us to retry loading the app now.
  ipcMain.on("app:retry", () => {
    retryDelay = 0;
    loadApp();
  });
  // Expose the resolved base URL to the offline page if it asks.
  ipcMain.handle("app:baseUrl", () => baseUrl);
  ipcMain.handle("app:saveBaseUrl", (event, raw) => {
    // Only the bundled settings page may change the persisted destination;
    // never let a remote server loaded in the shell rewrite local config.
    if (!event.senderFrame || !event.senderFrame.url.startsWith("file:")) {
      return { ok: false, error: "Settings can only be changed from Familiar." };
    }
    const normalized = require("./config").normalizeBaseUrl(raw);
    if (!normalized) return { ok: false, error: "Enter a valid http:// or https:// URL." };
    baseUrl = normalized;
    writeConfigFile(app, { baseUrl });
    loadApp();
    return { ok: true, baseUrl };
  });

  // macOS dock icon (runtime, since we launch unpackaged via `npm start`).
  // Guarded: app.dock only exists on darwin.
  if (process.platform === "darwin" && app.dock) {
    const p = iconPng(1024) || iconPng(512);
    if (p) {
      try {
        app.dock.setIcon(nativeImage.createFromPath(p));
      } catch (_) {
        /* best-effort: a missing/undecodable png must not block startup */
      }
    }
  }

  // Ensure the partitioned session exists (persistent cookie store on disk).
  session.fromPartition(PARTITION);

  // Microphone for tap-to-talk voice capture. The served page calls
  // getUserMedia({audio:true}); Electron must grant the `media` permission or
  // the prompt is silently denied. We only allow audio media, and only for our
  // own base origin — everything else stays denied.
  const part = session.fromPartition(PARTITION);
  const isOwnOrigin = (url) => {
    try { return !!baseUrl && new URL(url).origin === new URL(baseUrl).origin; }
    catch (_) { return false; }
  };
  part.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === "media") {
      const mediaTypes = (details && details.mediaTypes) || [];
      const audioOnly = mediaTypes.length === 0 || mediaTypes.every((t) => t === "audio");
      return callback(audioOnly && isOwnOrigin(details && details.requestingUrl || ""));
    }
    return callback(false);
  });
  part.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    if (permission === "media") return isOwnOrigin(requestingOrigin);
    return false;
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
