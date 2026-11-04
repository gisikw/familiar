const path = require("path");

// Where a download from the page lands. Familiar's Reader hands files over as
// blob downloads (<a download>); without a will-download handler Electron's
// behavior there is a save dialog at best, so the shell does what a browser
// does: straight into ~/Downloads, never overwriting, " (1)", " (2)" … on a
// clash. Pure, so it can be tested without Electron.

/** A safe leaf name: no directories, no dotfile-only or empty names. */
function safeName(raw) {
  let name = path.basename(String(raw || "").replace(/\\/g, "/")).replace(/[\u0000-\u001f]/g, "").trim();
  if (!name || name === "." || name === "..") name = "download";
  return name;
}

/** The first free path in dir for name, via exists(path) -> boolean. */
function uniqueDownloadPath(dir, raw, exists) {
  const name = safeName(raw);
  const ext = path.extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  let candidate = path.join(dir, name);
  for (let i = 1; exists(candidate) && i < 1000; i++) {
    candidate = path.join(dir, `${stem} (${i})${ext && ext !== name ? ext : ""}`);
  }
  return candidate;
}

module.exports = { safeName, uniqueDownloadPath };
