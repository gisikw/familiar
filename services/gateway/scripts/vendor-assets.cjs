#!/usr/bin/env node
// Postinstall: extract restty's self-contained browser bundle (WASM embedded)
// from the npm package so the gateway can serve it without a bundler.
//
// Fonts and emoji data are tracked directly by the gateway because it is their
// runtime owner. Static gateway assets must not depend on the dumb desktop
// client's source tree.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function copy(src, dst, label) {
  if (!fs.existsSync(src)) {
    console.warn(`[vendor-assets] missing ${label}: ${src} (skipping)`);
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  const kb = Math.round(fs.statSync(dst).size / 1024);
  console.log(`[vendor-assets] ${label} (${kb} KB)`);
}

// 1. restty bundle
copy(
  path.join(root, "node_modules", "restty", "dist", "restty.esm.js"),
  path.join(root, "vendor", "restty.esm.js"),
  "vendor/restty.esm.js",
);
