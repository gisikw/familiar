#!/usr/bin/env node
// Ensure node-pty's spawn-helper is executable. node-pty 1.1.0 ships prebuilt
// N-API binaries, and on macOS the `spawn-helper` companion binary is packed
// into the npm tarball WITHOUT its executable bit (mode 0644). posix_spawnp
// then fails with "posix_spawnp failed." at the first pty spawn.
//
// This is used both at install time (postinstall) and at app startup, so a
// working app results from a plain `npm install` and self-heals if the bit is
// ever lost again (e.g. a copy that drops perms).
const fs = require("fs");
const path = require("path");

function nodePtyBase() {
  try {
    return path.dirname(require.resolve("node-pty/package.json"));
  } catch (_) {
    // Fallback: assume sibling in node_modules.
    return path.resolve(__dirname, "..", "node_modules", "node-pty");
  }
}

// Return the list of every spawn-helper path this node-pty install might use:
// gyp-built (build/Release, build/Debug) and every prebuilds/<platform-arch>/.
function helperCandidates(base) {
  const out = [
    path.join(base, "build", "Release", "spawn-helper"),
    path.join(base, "build", "Debug", "spawn-helper"),
    path.join(
      base,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper"
    ),
  ];
  try {
    const pdir = path.join(base, "prebuilds");
    for (const d of fs.readdirSync(pdir)) {
      out.push(path.join(pdir, d, "spawn-helper"));
    }
  } catch (_) {
    /* no prebuilds dir */
  }
  return [...new Set(out)];
}

// Ensure 0755 on every present spawn-helper. Returns diagnostics for the caller
// (the in-window error panel uses these). Never throws.
function ensureSpawnHelperExecutable(base) {
  const results = [];
  const dir = base || nodePtyBase();
  for (const p of helperCandidates(dir)) {
    try {
      if (!fs.existsSync(p)) continue;
      let mode = fs.statSync(p).mode & 0o777;
      if ((mode & 0o111) === 0) {
        fs.chmodSync(p, 0o755);
        mode = fs.statSync(p).mode & 0o777;
      }
      // Best-effort: strip macOS quarantine so Gatekeeper doesn't block exec.
      if (process.platform === "darwin") {
        try {
          require("child_process").execFileSync(
            "/usr/bin/xattr",
            ["-d", "com.apple.quarantine", p],
            { stdio: "ignore" }
          );
        } catch (_) {
          /* attribute absent — fine */
        }
      }
      results.push({ path: p, mode });
    } catch (e) {
      results.push({ path: p, error: String((e && e.message) || e) });
    }
  }
  return results;
}

module.exports = { ensureSpawnHelperExecutable, helperCandidates, nodePtyBase };

// Allow direct execution (postinstall).
if (require.main === module) {
  const res = ensureSpawnHelperExecutable();
  if (res.length === 0) {
    console.log("[spawn-helper] no spawn-helper found (non-darwin prebuild?)");
  } else {
    for (const r of res) {
      if (r.error) console.warn(`[spawn-helper] ${r.path} -> ${r.error}`);
      else
        console.log(
          `[spawn-helper] ${r.path} -> mode ${(r.mode >>> 0).toString(8)}`
        );
    }
  }
}
