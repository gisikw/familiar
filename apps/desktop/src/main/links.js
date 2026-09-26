// Where a URL the page tries to open should go. The desktop shell stays a
// single window on Familiar: anything that asks for a new window (target=_blank,
// window.open, the reader's pop-out) goes to the default browser, and a link
// followed from Familiar's own page to anywhere else does too. Pure, so it can
// be tested without Electron.
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

const originOf = (raw) => { try { return new URL(raw).origin; } catch (_) { return null; } };

/** A request for a new window: open http(s)/mailto externally, never in-app. */
function windowOpenTarget(rawUrl) {
  try {
    return EXTERNAL_SCHEMES.has(new URL(rawUrl).protocol) ? "external" : "deny";
  } catch (_) {
    return "deny";
  }
}

/**
 * A renderer-initiated top-level navigation (Electron will-navigate; server
 * redirects never reach this). From Familiar's own page, only its own origin
 * stays in-app. Elsewhere (the bundled offline page, an identity/SSO page mid
 * login) navigation proceeds normally so those flows keep working.
 */
function navigationTarget(rawUrl, baseUrl, currentUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (_) { return "deny"; }
  if (u.protocol === "file:") return "allow";
  if (!EXTERNAL_SCHEMES.has(u.protocol)) return "deny";
  const base = originOf(baseUrl);
  const onFamiliar = base !== null && originOf(currentUrl) === base;
  if (!onFamiliar) return u.protocol === "mailto:" ? "external" : "allow";
  return u.origin === base ? "allow" : "external";
}

module.exports = { windowOpenTarget, navigationTarget };
