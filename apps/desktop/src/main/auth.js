// ---------------------------------------------------------------------------
// Electron glue for the generic OIDC native-app flow (see oidc.js).
//
// Responsibilities:
//   - persist tokens via safeStorage (userData/tokens.bin)
//   - attach "Authorization: Bearer" to requests aimed at the base URL
//   - on a 401 from the base URL, silently refresh or run the full
//     pop-out-to-system-browser dance, then reload
//
// The flow is triggered purely by standard signals: an RFC 9728 protected
// resource advertisement (/.well-known/oauth-protected-resource) discovered
// from the base URL, or a manually configured issuer (config.json:
// oidcIssuer + oidcClientId). Nothing here knows what sits in front of the
// server.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const oidc = require("./oidc");

const REFRESH_MARGIN_MS = 60_000; // refresh a minute before expiry
const DANCE_THROTTLE_MS = 30_000;

function tokensPath(app) {
  return path.join(app.getPath("userData"), "tokens.bin");
}

// --- Token persistence ----------------------------------------------------------

async function loadTokens(app) {
  try {
    const blob = fs.readFileSync(tokensPath(app));
    if (!app.safeStorage || app.safeStorage.isEncryptionAvailable() !== true) return null;
    const json = app.safeStorage.decryptString(blob);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null; // absent or unreadable tokens are just "not logged in"
  }
}

async function saveTokens(app, tokens) {
  if (!app.safeStorage || app.safeStorage.isEncryptionAvailable() !== true) {
    throw new Error("safeStorage unavailable; cannot persist tokens");
  }
  const blob = app.safeStorage.encryptString(JSON.stringify(tokens));
  fs.writeFileSync(tokensPath(app), blob, { mode: 0o600 });
}

async function clearTokens(app) {
  try {
    fs.unlinkSync(tokensPath(app));
  } catch (_) { /* already absent */ }
}

// --- Manager ----------------------------------------------------------------------

/**
 * Wire OIDC auth into the shell. Returns { attachHeaders, onResource401 }.
 * Call attachHeaders(session) once after the partition session exists.
 */
function createAuthManager({ app, getBaseUrl, getConfig, openExternal, getWindow, log = () => {} }) {
  let tokens = null;
  let inFlight = null;
  let lastDanceAt = 0;

  async function init() {
    tokens = await loadTokens(app);
    if (tokens) log("restored stored tokens");
  }

  function hasValidAccessToken() {
    return !!(tokens && tokens.accessToken && tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS);
  }

  async function refresh() {
    if (!tokens || !tokens.refreshToken) return false;
    const cfg = getConfig();
    const doc = await oidc.discoverIssuer(cfg.oidcIssuer);
    try {
      const next = await oidc.refreshTokens(doc.token_endpoint, {
        clientId: cfg.oidcClientId,
        refreshToken: tokens.refreshToken,
      });
      tokens = {
        ...next,
        refreshToken: next.refreshToken || tokens.refreshToken, // providers may not rotate
        issuer: tokens.issuer,
      };
      await saveTokens(app, tokens);
      log("token refresh ok");
      return true;
    } catch (err) {
      log(`token refresh failed: ${err.message}`);
      await clearTokens(app);
      tokens = null;
      return false;
    }
  }

  /**
   * The full dance: discover (or use configured) issuer, bind loopback,
   * open the system browser, exchange, persist. Resolves true on success.
   */
  async function runDance() {
    const cfg = getConfig();
    if (!cfg.oidcClientId) {
      log("no oidcClientId configured; cannot authenticate");
      return false;
    }
    let issuer = cfg.oidcIssuer;
    if (!issuer) {
      issuer = await oidc.discoverProtectedResource(getBaseUrl());
      if (!issuer) {
        log("resource advertises no authorization server and no issuer configured");
        return false;
      }
    }
    const doc = await oidc.discoverIssuer(issuer);
    const scope = cfg.oidcScope || "openid profile email offline_access";

    const pkce = oidc.createPkce();
    const state = oidc.randomState();
    const nonce = oidc.randomState();

    const result = await oidc.withLoopbackRedirect(async (redirectUri) => {
      const url = oidc.buildAuthorizeUrl(doc.authorization_endpoint, {
        clientId: cfg.oidcClientId,
        redirectUri,
        scope,
        state,
        nonce,
        codeChallenge: pkce.challenge,
      });
      log("opening system browser for authorization");
      await openExternal(url);
    });

    if (result.state !== state) throw new Error("state mismatch in authorization callback");
    const exchanged = await oidc.exchangeCode(doc.token_endpoint, {
      clientId: cfg.oidcClientId,
      code: result.code,
      verifier: pkce.verifier,
      redirectUri: result.redirectUri,
    });
    tokens = { ...exchanged, issuer };
    await saveTokens(app, tokens);
    log("authorization complete");
    return true;
  }

  /** Serialize: only one dance/refresh at a time. */
  function ensureAuthenticated({ forceDance = false } = {}) {
    if (inFlight) return inFlight;
    const now = Date.now();
    if (!forceDance && now - lastDanceAt < DANCE_THROTTLE_MS) {
      return Promise.resolve(false);
    }
    lastDanceAt = now;
    inFlight = (async () => {
      try {
        if (forceDance || !tokens) return await runDance();
        if (await refresh()) return true;
        return await runDance();
      } catch (err) {
        log(`authentication failed: ${err.message}`);
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /** Header attachment: bearer on same-origin requests only, when logged in. */
  function attachHeaders(ses) {
    const baseOrigin = () => {
      try { return new URL(getBaseUrl()).origin; } catch (_) { return null; }
    };
    ses.webRequest.onBeforeSendHeaders({ urls: ["*://*/*"] }, (details, callback) => {
      const requestHeaders = details.requestHeaders;
      const origin = baseOrigin();
      const sameOrigin = origin && details.url.startsWith(origin);
      // Main frame included: the served page load itself must pass the
      // resource's auth gate. Off-origin requests are never touched.
      if (sameOrigin && tokens && tokens.accessToken) {
        requestHeaders.Authorization = `Bearer ${tokens.accessToken}`;
      }
      callback({ requestHeaders });
    });
    // A 401 from the resource means: refresh silently, or dance, then reload.
    ses.webRequest.onCompleted({ urls: ["*://*/*"] }, (details) => {
      const origin = baseOrigin();
      if (!origin || !details.url.startsWith(origin)) return;
      if (details.statusCode !== 401 && details.statusCode !== 403) return;
      const force = !hasValidAccessToken();
      ensureAuthenticated({ forceDance: force }).then((ok) => {
        if (ok) {
          log("re-authenticated; reloading");
          const win = getWindow && getWindow();
          if (win && !win.isDestroyed()) win.webContents.loadURL(getBaseUrl()).catch(() => {});
        }
      });
    });
  }

  return { init, attachHeaders, ensureAuthenticated, hasValidAccessToken, clearTokens };
}

module.exports = { createAuthManager, loadTokens, saveTokens, clearTokens };
