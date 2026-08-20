#!/usr/bin/env node
// Postinstall: (1) vendor the restty bundle, (2) make node-pty's prebuilt
// spawn-helper executable.
//
// node-pty 1.1.0 ships prebuilt N-API binaries — N-API is ABI-stable across
// Node and Electron, so NO native recompile (node-gyp / electron-rebuild) is
// needed, and therefore no Python/Xcode toolchain is required. The one gotcha
// is that the macOS `spawn-helper` binary is packed in the tarball without its
// executable bit (mode 0644), which makes posix_spawnp fail at first spawn.
// We fix that here so a plain `npm install` yields a working app.
const { execFileSync } = require("child_process");
const path = require("path");

function run(script) {
  execFileSync(process.execPath, [path.join(__dirname, script)], {
    stdio: "inherit",
    cwd: path.resolve(__dirname, ".."),
  });
}

try {
  run("vendor-restty.js");
} catch (e) {
  console.warn("[postinstall] vendor-restty failed:", e && e.message);
}

try {
  run("ensure-spawn-helper.js");
} catch (e) {
  console.warn(
    "[postinstall] ensure-spawn-helper failed (non-fatal):",
    e && e.message
  );
}
