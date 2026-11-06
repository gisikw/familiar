// When the shell may put its OIDC bearer on an outgoing request. Pure, so it's
// unit-tested without Electron.
//
// The served app can carry its own Authorization header: familiar-ui's /v1/*
// calls send the bridge bearer from /__familiar/bridge.json, and nginx keeps
// identity SSO off that header. Overwriting it with the shell's OIDC token
// turned every /v1 call into a 401, the 401 kicked off a fresh login dance,
// the reload 401'd again, and the app looped (desktop 0.2.15 with an https
// base; an http base hid it because no https request was "ours").

/** Find a header case-insensitively; Chromium preserves the page's casing. */
function headerKey(headers, name) {
  const want = name.toLowerCase();
  for (const k of Object.keys(headers || {})) if (k.toLowerCase() === want) return k;
  return null;
}

/**
 * Whether to inject `Authorization: Bearer <token>`: only on our own origin,
 * only with a token, and never over an Authorization the page set itself.
 */
function shouldInjectBearer(requestHeaders, sameOrigin, accessToken) {
  if (!sameOrigin || !accessToken) return false;
  return headerKey(requestHeaders, "Authorization") === null;
}

module.exports = { headerKey, shouldInjectBearer };
