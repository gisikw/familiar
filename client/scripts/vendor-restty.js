#!/usr/bin/env node
// Copies restty's self-contained standalone ESM bundle (WASM embedded as base64,
// text-shaper bundled) out of node_modules into src/renderer/vendor so the
// renderer can `import` it directly with no bundler. Runs on postinstall.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const src = path.join(root, "node_modules", "restty", "dist", "restty.esm.js");
const outDir = path.join(root, "src", "renderer", "vendor");
const out = path.join(outDir, "restty.esm.js");

if (!fs.existsSync(src)) {
  console.error(
    "[vendor-restty] restty not found at " +
      src +
      "\n  Run `npm install` first. Skipping."
  );
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, out);
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`[vendor-restty] wrote src/renderer/vendor/restty.esm.js (${kb} KB)`);
