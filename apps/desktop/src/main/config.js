const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Config surface for the dumb chrome shell.
//
// The client is now a thin Electron window that LOADS the familiar server's
// served terminal page. The only thing it needs to know is the BASE URL of that
// server; every endpoint (the terminal page itself, the /pty WebSocket, the
// /upload drop target) is owned by the served page, derived from that origin by
// the browser context — we never hard-code a path here.
//
// Resolution order for the base URL (first hit wins):
//   1. FAMILIAR_BASE_URL environment variable
//   2. "baseUrl" key in <userData>/config.json
//   3. DEFAULT_BASE_URL
//
// Window bounds are persisted in the same JSON so the window reopens where it
// was left.
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://familiar.gisi.network";

// Normalize to an origin+path with no trailing slash noise. We keep whatever
// path the user configured (in case the server ever lives under a sub-path),
// but strip a bare trailing "/" so "https://host/" and "https://host" match.
function normalizeBaseUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let out = u.origin + u.pathname;
  if (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function configPath(app) {
  return path.join(app.getPath("userData"), "config.json");
}

function readConfigFile(app) {
  try {
    const raw = fs.readFileSync(configPath(app), "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch (_) {
    return {};
  }
}

function writeConfigFile(app, patch) {
  const cur = readConfigFile(app);
  const next = { ...cur, ...patch };
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(configPath(app), JSON.stringify(next, null, 2) + "\n");
  } catch (_) {
    /* best-effort; a read-only userData just means non-persistent bounds */
  }
  return next;
}

// Resolve the base URL. `app` may be null in a plain-node unit test, in which
// case the JSON file is skipped (env + default only).
function resolveBaseUrl(app, fileCfg) {
  const fromEnv = normalizeBaseUrl(process.env.FAMILIAR_BASE_URL);
  if (fromEnv) return fromEnv;
  const cfg = fileCfg || (app ? readConfigFile(app) : {});
  const fromFile = normalizeBaseUrl(cfg.baseUrl);
  if (fromFile) return fromFile;
  return DEFAULT_BASE_URL;
}

module.exports = {
  DEFAULT_BASE_URL,
  normalizeBaseUrl,
  resolveBaseUrl,
  configPath,
  readConfigFile,
  writeConfigFile,
};
