#!/usr/bin/env node
// ensure-app-name.js — make the dock/app-switcher say "Familiar", not "Electron".
//
// When the app runs unpackaged (`npm start`), macOS reads the hover name from
// the Electron.app bundle's Info.plist (CFBundleName/CFBundleDisplayName) —
// `app.setName()` does not reach it. The standard dev workaround is to patch
// the plist inside node_modules. Idempotent; runs from the prestart hook; a
// no-op on non-darwin or when the plist is already patched. A future packaged
// build (electron-builder productName) makes this unnecessary.
"use strict";
const fs = require("fs");
const path = require("path");

if (process.platform !== "darwin") process.exit(0);

const plist = path.join(
  __dirname, "..", "node_modules", "electron", "dist",
  "Electron.app", "Contents", "Info.plist",
);

let text;
try {
  text = fs.readFileSync(plist, "utf8");
} catch {
  process.exit(0); // electron not installed yet; nothing to patch
}

const patched = text
  .replace(
    /(<key>CFBundleName<\/key>\s*<string>)Electron(<\/string>)/,
    "$1Familiar$2",
  )
  .replace(
    /(<key>CFBundleDisplayName<\/key>\s*<string>)Electron(<\/string>)/,
    "$1Familiar$2",
  );

if (patched !== text) {
  fs.writeFileSync(plist, patched);
  console.log("ensure-app-name: patched Electron.app Info.plist -> Familiar");
}
