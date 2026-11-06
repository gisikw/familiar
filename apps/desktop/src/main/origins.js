// Origin matching for the shell's permission grants (microphone, clipboard
// writes, downloads). Kept pure so it can be unit-tested without Electron.
//
// A grant is bound to the base URL's origin. Two things made the old exact
// compare too brittle:
//   - Chromium hands the permission handlers different shapes depending on the
//     path: a full requesting URL, a security origin with a trailing slash, or
//     an empty string (some media checks). An empty or unparseable value must
//     fall back to the URL actually loaded in the requesting webContents rather
//     than read as "foreign".
//   - Deployments move (familiar-ui.gisi.network → familiar.gisi.network). A
//     page still on a moved origin is ours too.

const { migrateBaseUrl } = require("./config");

function originOf(value) {
  if (!value) return null;
  try {
    const u = new URL(String(value));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch (_) {
    return null;
  }
}

/** The origin(s) the shell treats as its own for a given base URL. */
function ownOrigins(baseUrl) {
  const set = new Set();
  const base = originOf(baseUrl);
  if (base) set.add(base);
  // An http base on a real host is upgraded to https by the server (HSTS or a
  // redirect), so the page the window actually shows is the https origin of
  // the same host. Count it as ours. The reverse (https base, http page) is a
  // downgrade and stays foreign. Loopback hosts are left exact.
  if (base && base.startsWith("http://")) {
    const host = new URL(base).hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
      set.add("https://" + base.slice("http://".length));
    }
  }
  return set;
}

/** True when `url` (a URL or origin) is one of our own origins. */
function isOwnOrigin(url, baseUrl) {
  const o = originOf(url);
  if (!o) return false;
  const own = ownOrigins(baseUrl);
  if (own.has(o)) return true;
  // A moved origin counts when it migrates onto our base, but only a move
  // that keeps the scheme: an http page is never ours just because its saved
  // base would be upgraded (that would accept a downgrade).
  const migrated = originOf(migrateBaseUrl(o));
  return !!migrated && migrated.split(":")[0] === o.split(":")[0] && own.has(migrated);
}

/**
 * The first usable origin among the candidates Chromium/Electron give us,
 * most specific first (requesting URL, security origin, the frame's URL, the
 * webContents' URL). Empty/opaque values are skipped.
 */
function pickRequestOrigin(...candidates) {
  for (const c of candidates) {
    const o = originOf(c);
    if (o) return o;
  }
  return null;
}

module.exports = { originOf, ownOrigins, isOwnOrigin, pickRequestOrigin };
