// Headless self-test harness for the DUMB CLIENT. Launched via
// `electron . --selftest`.
//
// The client no longer owns a pty, a renderer, or drops — the served page does.
// So this harness verifies the shell's own responsibilities:
//   1. config: base-URL resolution (env > userData JSON > default) + normalize.
//   2. bounds persistence round-trips through the JSON config.
//   3. the offline/retry page is present and loads in a BrowserWindow, and its
//      retry button is wired to the app:retry IPC.
//   4. (optional, opt-in) if FAMILIAR_SELFTEST_LIVE=1 and a reachable
//      FAMILIAR_BASE_URL is set, load it in a partitioned window and confirm a
//      main-frame document loads (an end-to-end "the page renders" smoke). This
//      is skipped by default because the sandbox has no display/server; state
//      it rather than fake it.
//
// Exit 0 = pass, 1 = fail. Electron itself needs a display; on a headless box
// this runs under xvfb or Electron's offscreen path — where that's not
// available we still run the pure-config checks below (they need no window).

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");

const cfg = require("../main/config");

const OUT = path.join(os.tmpdir(), "familiar-selftest");
fs.mkdirSync(OUT, { recursive: true });

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

// --- Pure-config checks (no window needed) --------------------------------
function checkConfig() {
  // normalizeBaseUrl
  const cases = [
    ["https://familiar.example.com/", "https://familiar.example.com"],
    ["https://familiar.example.com", "https://familiar.example.com"],
    ["http://localhost:1692/", "http://localhost:1692"],
    ["  https://x.example/sub/  ", "https://x.example/sub"],
    ["ftp://nope", null],
    ["not a url", null],
    ["", null],
  ];
  for (const [input, want] of cases) {
    const got = cfg.normalizeBaseUrl(input);
    if (got !== want) {
      return `normalizeBaseUrl(${JSON.stringify(input)}) = ${JSON.stringify(
        got
      )}, want ${JSON.stringify(want)}`;
    }
  }
  log("normalizeBaseUrl OK");

  // Default when nothing set.
  const savedEnv = process.env.FAMILIAR_BASE_URL;
  delete process.env.FAMILIAR_BASE_URL;
  const def = cfg.resolveBaseUrl(null, {});
  if (def !== cfg.DEFAULT_BASE_URL) {
    return `default base url = ${def}, want ${cfg.DEFAULT_BASE_URL}`;
  }
  log("default base URL OK:", def);

  // Env wins over file.
  process.env.FAMILIAR_BASE_URL = "https://env.example";
  const viaEnv = cfg.resolveBaseUrl(null, { baseUrl: "https://file.example" });
  if (viaEnv !== "https://env.example") {
    return `env should win, got ${viaEnv}`;
  }
  // File used when env absent/invalid.
  delete process.env.FAMILIAR_BASE_URL;
  const viaFile = cfg.resolveBaseUrl(null, { baseUrl: "https://file.example" });
  if (viaFile !== "https://file.example") {
    return `file base url should win over default, got ${viaFile}`;
  }
  if (savedEnv === undefined) delete process.env.FAMILIAR_BASE_URL;
  else process.env.FAMILIAR_BASE_URL = savedEnv;
  log("resolveBaseUrl precedence OK (env > file > default)");

  // Bounds round-trip through the real userData JSON.
  cfg.writeConfigFile(app, { bounds: { x: 5, y: 6, width: 700, height: 500 } });
  const back = cfg.readConfigFile(app);
  if (
    !back.bounds ||
    back.bounds.width !== 700 ||
    back.bounds.height !== 500 ||
    back.bounds.x !== 5
  ) {
    return "bounds did not round-trip through config.json: " + JSON.stringify(back);
  }
  log("bounds persistence OK ->", cfg.configPath(app));

  return null;
}

// --- Offline page render smoke -------------------------------------------
async function checkOfflinePage() {
  const OFFLINE = path.join(__dirname, "..", "main", "offline.html");
  if (!fs.existsSync(OFFLINE)) throw new Error("offline.html missing");

  let retried = false;
  ipcMain.on("app:retry", () => {
    retried = true;
  });

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await win.loadFile(OFFLINE, {
    search: "url=https://familiar.example.com&err=selftest",
  });
  await new Promise((r) => setTimeout(r, 400));

  // The page should show the base URL we passed.
  const urlText = await win.webContents.executeJavaScript(
    "document.getElementById('url').textContent"
  );
  if (!/familiar\.example\.com/.test(urlText)) {
    throw new Error("offline page did not render base URL, got: " + urlText);
  }

  // Preload bridge must be present and retry() must reach main.
  const hasBridge = await win.webContents.executeJavaScript(
    "!!(window.familiar && typeof window.familiar.retry === 'function')"
  );
  if (!hasBridge) throw new Error("preload bridge (familiar.retry) missing");

  await win.webContents.executeJavaScript("window.familiar.retry(); true");
  await new Promise((r) => setTimeout(r, 200));
  if (!retried) throw new Error("app:retry IPC did not fire from offline page");

  const img = await win.webContents.capturePage();
  const shot = path.join(OUT, "offline.png");
  fs.writeFileSync(shot, img.toPNG());
  log("offline page OK; screenshot ->", shot);
  win.destroy();
}

// --- Optional live smoke --------------------------------------------------
async function checkLive() {
  if (process.env.FAMILIAR_SELFTEST_LIVE !== "1") {
    log("live smoke SKIPPED (set FAMILIAR_SELFTEST_LIVE=1 + FAMILIAR_BASE_URL)");
    return;
  }
  const base = cfg.resolveBaseUrl(app);
  log("live smoke: loading", base);
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    webPreferences: {
      partition: "persist:familiar-selftest",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadURL(base);
  await new Promise((r) => setTimeout(r, 2000));
  const title = await win.webContents.executeJavaScript("document.title");
  log("live smoke loaded, document.title:", JSON.stringify(title));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, "live.png"), img.toPNG());
  win.destroy();
}

async function run() {
  const cfgErr = checkConfig();
  if (cfgErr) return fail(cfgErr);
  await checkOfflinePage();
  await checkLive();
  pass();
}

app.whenReady().then(() =>
  run().catch((e) => fail("exception: " + (e && e.stack ? e.stack : e)))
);
