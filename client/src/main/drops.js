const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Where dropped files land. Created on demand.
const DROPS_DIR = path.join(os.homedir(), ".familiar", "drops");

function ensureDir() {
  fs.mkdirSync(DROPS_DIR, { recursive: true });
}

// Sanitize a dropped filename to a safe basename; if it collides, prefix with
// a short content hash so we never clobber an earlier drop.
function safeName(name, bytes) {
  const base = path.basename(name || "dropped-file").replace(/[^\w.\-]+/g, "_");
  const target = path.join(DROPS_DIR, base);
  if (!fs.existsSync(target)) return base;
  const hash = crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 8);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  return `${stem}.${hash}${ext}`;
}

// Persist path + bytes into ~/.familiar/drops/. Returns the saved path.
// Also records the original source name in a sidecar manifest so we retain
// the "path" of the drop as the task requires.
function saveDrop(name, bytes) {
  ensureDir();
  const finalName = safeName(name, bytes);
  const dest = path.join(DROPS_DIR, finalName);
  fs.writeFileSync(dest, bytes);

  const manifest = path.join(DROPS_DIR, "manifest.jsonl");
  const record = {
    ts: new Date().toISOString(),
    original: name,
    saved: dest,
    bytes: bytes.length,
  };
  fs.appendFileSync(manifest, JSON.stringify(record) + "\n");

  return { saved: dest, name: finalName, bytes: bytes.length };
}

module.exports = { saveDrop, DROPS_DIR };
