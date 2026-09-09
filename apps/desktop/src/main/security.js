const path = require("path");
const { fileURLToPath } = require("url");

// Parse both sides before comparing. String-prefix checks are not origin checks:
// https://app.example.evil/ starts with https://app.example.
function isSameOrigin(rawUrl, expectedOrigin) {
  try {
    return new URL(rawUrl).origin === new URL(expectedOrigin).origin;
  } catch (_) {
    return false;
  }
}

// The preload is present when the main window swaps between remote content and
// offline.html. Keep its IPC useful only to the exact bundled pages that need
// it; file: by itself is too broad an authorization boundary.
function isAllowedBundledFile(rawUrl, allowedPaths) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "file:") return false;
    const actual = path.resolve(fileURLToPath(u));
    return allowedPaths.some((candidate) => actual === path.resolve(candidate));
  } catch (_) {
    return false;
  }
}

module.exports = { isSameOrigin, isAllowedBundledFile };
