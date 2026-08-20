const os = require("os");
const fs = require("fs");
const path = require("path");
const {
  ensureSpawnHelperExecutable,
} = require("../../scripts/ensure-spawn-helper.js");

// node-pty is loaded lazily so an ABI/load failure surfaces as a readable
// diagnostic (see loadNodePty) rather than crashing at require-time.
let _pty = null;
let _ptyLoadError = null;
function loadNodePty() {
  if (_pty) return _pty;
  if (_ptyLoadError) throw _ptyLoadError;
  try {
    _pty = require("node-pty");
    return _pty;
  } catch (err) {
    _ptyLoadError = err;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// ROOT CAUSE (macOS): node-pty 1.1.0 ships prebuilt N-API binaries; its
// `spawn-helper` companion is packed WITHOUT the executable bit (mode 0644), so
// posix_spawnp fails at the first pty spawn. ensureSpawnHelperExecutable()
// (shared with the postinstall script) chmods every candidate spawn-helper to
// 0755 and strips macOS quarantine. Best-effort; never throws.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cause #3: resolve a shell that actually exists. Honor $SHELL, then fall back
// through a sane list. Never return a path that doesn't exist.
// ---------------------------------------------------------------------------
function resolveShell() {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "cmd.exe";
  }
  const candidates = [
    process.env.SHELL,
    "/bin/zsh", // macOS default since Catalina
    "/bin/bash",
    "/bin/sh",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {
      /* ignore */
    }
  }
  // Last resort — let posix_spawnp try /bin/sh even if the stat failed.
  return "/bin/sh";
}

// ---------------------------------------------------------------------------
// Cause #2: cwd must exist in the GUI context or posix_spawnp fails. Return a
// directory that definitely exists.
// ---------------------------------------------------------------------------
function resolveCwd() {
  const candidates = [os.homedir(), process.env.HOME, "/tmp", "/"];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch (_) {
      /* ignore */
    }
  }
  return "/";
}

// ---------------------------------------------------------------------------
// Cause #3 (env hygiene): a GUI-launched Electron may inherit env from a
// nix-shell used to install. PATH entries and NIX_* vars pointing into
// /nix/store won't resolve the same way for the shell child and can break
// things. Strip nix-specific vars and prune /nix/store PATH entries, keeping a
// sane default PATH so the login shell can find its own tools.
// ---------------------------------------------------------------------------
function sanitizeEnv(baseEnv) {
  const env = { ...baseEnv };

  // Drop all NIX_* and nix-shell markers.
  for (const key of Object.keys(env)) {
    if (key.startsWith("NIX_")) delete env[key];
  }
  delete env.IN_NIX_SHELL;
  delete env.NIX_STORE;
  delete env.NIXPKGS_CONFIG;
  delete env.__ETC_PROFILE_SOURCED;
  delete env.__NIX_DARWIN_SET_ENVIRONMENT_DONE;

  // Prune /nix/store entries from PATH; ensure standard dirs are present so the
  // shell's own startup can rebuild PATH properly.
  const stdDirs = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const cur = (env.PATH || "").split(":").filter(Boolean);
  const pruned = cur.filter((p) => !p.startsWith("/nix/store"));
  const merged = [];
  for (const p of [...pruned, ...stdDirs]) {
    if (p && !merged.includes(p)) merged.push(p);
  }
  env.PATH = merged.join(":");

  return env;
}

// ---------------------------------------------------------------------------
// Spawn a login, interactive shell in a real PTY.
// Throws a rich Error (with .diagnostics attached) on failure so the caller can
// render it in-window instead of crashing.
// ---------------------------------------------------------------------------
function spawn({ cols, rows, onData, onExit }) {
  const helperInfo = ensureSpawnHelperExecutable();
  const nodePty = loadNodePty();

  const shell = resolveShell();
  const shellName = shell.split("/").pop();
  const cwd = resolveCwd();
  const isWin = process.platform === "win32";
  const args = isWin ? [] : ["-l"];

  const env = sanitizeEnv({
    ...process.env,
    TERM: "xterm-256color",
    TERM_PROGRAM: "Familiar",
    COLORTERM: "truecolor",
  });

  const diagnostics = {
    shell,
    shellExists: (() => {
      try {
        return fs.existsSync(shell);
      } catch (_) {
        return false;
      }
    })(),
    args,
    cwd,
    cwdExists: (() => {
      try {
        return fs.existsSync(cwd);
      } catch (_) {
        return false;
      }
    })(),
    spawnHelper: helperInfo,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    modules: process.versions.modules,
    pathHead: (env.PATH || "").split(":").slice(0, 6),
  };

  let child;
  try {
    child = nodePty.spawn(shell, args, {
      name: "xterm-256color",
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env,
    });
  } catch (err) {
    // Attach everything we know so the window can show a real diagnostic.
    const wrapped = new Error(
      `Failed to start the shell (${err && err.message}).`
    );
    wrapped.cause = err;
    wrapped.diagnostics = diagnostics;
    throw wrapped;
  }

  child.onData(onData);
  child.onExit(onExit);

  return {
    proc: child,
    shellName,
    diagnostics,
    write: (data) => child.write(data),
  };
}

function resize(handle, cols, rows) {
  try {
    handle.proc.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
  } catch (_) {
    /* pty may have exited */
  }
}

function kill(handle) {
  try {
    handle.proc.kill();
  } catch (_) {
    /* already gone */
  }
}

module.exports = {
  spawn,
  resizePty: resize,
  killPty: kill,
  // Exposed for diagnostics / self-test.
  resolveShell,
  resolveCwd,
  sanitizeEnv,
  ensureSpawnHelperExecutable,
};
