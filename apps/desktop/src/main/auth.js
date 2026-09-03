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

// The client is a PUBLIC OAuth client (RFC 8252): its id is an identifier,
// not a secret — PKCE protects the flow, so shipping the id is exactly what
// VS Code / gh / the AWS CLI do. Registered once in the IdP; overrides in
// config.json (oidcClientId) still win for nonstandard deployments.
const DEFAULT_OIDC_CLIENT_ID = "familiar-desktop";
const DEFAULT_OIDC_SCOPE = "openid profile email offline_access";
// Fixed loopback port: registered on the IdP as http://127.0.0.1:17421/callback
// (RFC 8252 §7.3 — specific port for providers that match URIs literally).
const LOOPBACK_PORT = 17421;

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
    const doc = await oidc.discoverIssuer(cfg.oidcIssuer || tokens.issuer);
    try {
      const next = await oidc.refreshTokens(doc.token_endpoint, {
        clientId: cfg.oidcClientId || DEFAULT_OIDC_CLIENT_ID,
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
    const clientId = cfg.oidcClientId || DEFAULT_OIDC_CLIENT_ID;
    let issuer = cfg.oidcIssuer;
    if (!issuer) {
      issuer = await oidc.discoverProtectedResource(getBaseUrl());
      if (!issuer) {
        log("resource advertises no authorization server and no issuer configured");
        return false;
      }
    }
    const doc = await oidc.discoverIssuer(issuer);
    const scope = cfg.oidcScope || DEFAULT_OIDC_SCOPE;

    const pkce = oidc.createPkce();
    const state = oidc.randomState();
    const nonce = oidc.randomState();

    // Fixed loopback port: RFC 8252 §7.3 explicitly blesses "a specific port
    // rather than a random one" for providers (like pocket-id) that match
    // redirect URIs literally instead of ignoring the port. The registered
    // callback is http://127.0.0.1:17421/callback.
    const result = await oidc.withLoopbackRedirect(async (redirectUri) => {
      const url = oidc.buildAuthorizeUrl(doc.authorization_endpoint, {
        clientId,
        redirectUri,
        scope,
        state,
        nonce,
        codeChallenge: pkce.challenge,
      });
      log("opening system browser for authorization");
      await openExternal(url);
    }, { port: LOOPBACK_PORT });

    if (result.state !== state) throw new Error("state mismatch in authorization callback");
    const exchanged = await oidc.exchangeCode(doc.token_endpoint, {
      clientId,
      code: result.code,
      verifier: pkce.verifier,
      redirectUri: result.redirectUri,
    });
    tokens = { ...exchanged, issuer };
    try {
      await saveTokens(app, tokens);
    } catch (err) {
      // Non-fatal: in-memory tokens still authenticate this session.
      log(`persisting tokens failed (${err.message}); session is memory-only`);
    }
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
    const isLoginRedirect = (url) => {
      const origin = baseOrigin();
      return !!origin && url.startsWith(origin) && url.includes("/_identity/login");
    };

    /**
     * Mirror the access token into a session cookie. Chromium sends session
     * cookies on WebSocket handshakes where webRequest header injection is
     * unreliable; nginx maps _fort_bearer back into an Authorization header
     * for the auth subrequest. Best-effort — headers still carry the token
     * for everything webRequest does cover.
     */
    const syncBearerCookie = async () => {
      if (!baseOrigin()) return;
      try {
        if (tokens && tokens.accessToken) {
          await ses.cookies.set({
            url: getBaseUrl(),
            name: "_fort_bearer",
            value: tokens.accessToken,
            expirationDate: Math.floor((tokens.expiresAt || Date.now() + 3600_000) / 1000),
            sameSite: "no_restriction",
            secure: getBaseUrl().startsWith("https:"),
          });
        } else {
          const existing = await ses.cookies.get({ name: "_fort_bearer" });
          for (const c of existing) await ses.cookies.remove(getBaseUrl(), "_fort_bearer");
        }
      } catch (err) {
        log(`bearer cookie sync failed: ${err.message}`);
      }
    };
    const origRefresh = refresh;
    refresh = async () => {
      const ok = await origRefresh();
      await syncBearerCookie();
      return ok;
    };
    const origRunDance = runDance;
    runDance = async () => {
      const ok = await origRunDance();
      await syncBearerCookie();
      return ok;
    };
    void syncBearerCookie();
    // Cookie-path fallback: if the standard dance can't run (no advertisement,
    // no client registration), let the server's own login redirect through.
    let cookieFallbackUntil = 0;
    const FALLBACK_MS = 10 * 60_000;

    ses.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
      // The resource's 401 surfaces here as a 302 to its login endpoint
      // (nginx error_page interception) — that IS the auth signal. Cancel it
      // and run the standard dance; on dance failure, fall through to the
      // cookie path for a while instead of looping.
      if (isLoginRedirect(details.url) && Date.now() > cookieFallbackUntil) {
        cookieFallbackUntil = Date.now() + FALLBACK_MS;
        // Replace the intercepted nav with a neutral signing-in state so the
        // user doesn't stare at a stale page (or a flash of the login flow).
        const win = getWindow && getWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.loadURL(
            "data:text/html," +
              encodeURIComponent(
                '<!doctype html><title>Familiar</title><body style="font:14px sans-serif;background:#282828;color:#d5c4a1;display:grid;place-items:center;height:100vh;margin:0"><p>Signing in&hellip;</p></body>'
              )
          ).catch(() => {});
        }
        ensureAuthenticated({ forceDance: true }).then((ok) => {
          log(ok ? "standard dance complete; reloading" : "dance unavailable; falling back to cookie login");
          const w2 = getWindow && getWindow();
          if (w2 && !w2.isDestroyed()) w2.webContents.loadURL(getBaseUrl()).catch(() => {});
        });
        callback({ cancel: true });
        return;
      }
      callback({});
    });
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
    // A 401/403 that still reaches the client (resource without nginx
    // interception) means the same thing: refresh silently, or dance.
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
