#!/usr/bin/env node
// Postinstall: vendor the browser-terminal static assets so the server can
// serve them with no bundler.
//   1. restty's self-contained ESM bundle (WASM embedded) -> vendor/restty.esm.js
//   2. fonts (ProggyClean NF, JetBrains Mono, OpenMoji cmap) -> fonts/
//   3. emoji.json (Slack-style :name: completer data)        -> vendor/emoji.json
//
// Fonts + emoji.json are copied from ../../apps/desktop/src/renderer (the Electron
// renderer already carries the tracked upstream copies) so there is a single
// source of truth. restty comes from this package's own node_modules.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const repo = path.resolve(root, "..", "..");
const clientRenderer = path.join(repo, "apps", "desktop", "src", "renderer");

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

// 2. fonts
const fonts = [
  "ProggyCleanNerdFontMono-Regular.ttf",
  "JetBrainsMono-Regular.ttf",
  "JetBrainsMono-Bold.ttf",
  "JetBrainsMono-Italic.ttf",
  "OpenMoji-black-glyf.ttf",
];
for (const f of fonts) {
  copy(path.join(clientRenderer, "fonts", f), path.join(root, "fonts", f), `fonts/${f}`);
}

// 3. emoji data
copy(
  path.join(clientRenderer, "vendor", "emoji.json"),
  path.join(root, "vendor", "emoji.json"),
  "vendor/emoji.json",
);
