// ---------------------------------------------------------------------------
// Generic OIDC native-app client logic (RFC 8252 / OAuth 2.0 for Native Apps).
//
// Deliberately knows NOTHING about the auth infrastructure in front of any
// particular deployment: no tailscale paths, no gateway internals, no token
// formats. Given an issuer, this module speaks standard OIDC:
//
//   discovery -> authorization code + PKCE -> loopback redirect catch ->
//   token exchange -> refresh grant.
//
// All network and storage concerns are injectable so the flow is unit-testable
// without Electron. The Electron-facing glue lives in auth.js.
// ---------------------------------------------------------------------------

const http = require("http");
const crypto = require("crypto");

// --- PKCE (RFC 7636) ---------------------------------------------------------

function createPkce(rng = crypto.randomBytes) {
  const verifier = rng(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

function randomState(rng = crypto.randomBytes) {
  return rng(16).toString("base64url");
}

// --- Discovery ----------------------------------------------------------------

async function fetchJson(url, fetchLike) {
  const doFetch = fetchLike || globalThis.fetch;
  const res = await doFetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

/**
 * RFC 9728 Protected Resource Metadata: how a resource server tells a client
 * which authorization servers guard it. Returns the issuer string, or null if
 * the resource advertises nothing (caller falls back to manual issuer config).
 */
async function discoverProtectedResource(baseUrl, fetchLike) {
  const url = `${baseUrl.replace(/\/$/, "")}/.well-known/oauth-protected-resource`;
  try {
    const meta = await fetchJson(url, fetchLike);
    const issuer = meta && Array.isArray(meta.authorization_servers) && meta.authorization_servers[0];
    return typeof issuer === "string" && issuer ? issuer.replace(/\/$/, "") : null;
  } catch (_) {
    return null;
  }
}

async function discoverIssuer(issuer, fetchLike) {
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const doc = await fetchJson(url, fetchLike);
  for (const key of ["authorization_endpoint", "token_endpoint"]) {
    if (typeof doc[key] !== "string" || !doc[key]) throw new Error(`issuer discovery missing ${key}`);
  }
  return doc;
}

// --- URL construction -----------------------------------------------------------

function buildAuthorizeUrl(authorizationEndpoint, opts) {
  const u = new URL(authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("scope", opts.scope);
  u.searchParams.set("state", opts.state);
  u.searchParams.set("nonce", opts.nonce);
  u.searchParams.set("code_challenge", opts.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

// --- Loopback redirect catch (RFC 8252 section 7.1) ------------------------------

const AUTH_COMPLETE_HTML =
  "<!doctype html><title>Familiar</title><body style=\"font:14px sans-serif;background:#282828;color:#d5c4a1;display:grid;place-items:center;height:100vh;margin:0\"><p>Authentication complete &mdash; you can close this tab.</p></body>";

/**
 * Full loopback dance: bind a one-shot listener on 127.0.0.1:<ephemeral>
 * first, then hand the redirect URI to `run(redirectUri, cancel)` so the
 * caller can build the authorize URL and open the system browser, then await
 * the provider's redirect. Resolves {code, state, redirectUri}; rejects on
 * provider-reported error, timeout, or explicit cancel.
 */
async function withLoopbackRedirect(run, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const done = (fn, arg) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(AUTH_COMPLETE_HTML);
        server.close(() => fn(arg));
      };
      const err = u.searchParams.get("error");
      if (err) {
        done(reject, new Error(`provider error: ${err}${u.searchParams.get("error_description") ? ` (${u.searchParams.get("error_description")})` : ""}`));
        return;
      }
      const code = u.searchParams.get("code");
      if (!code) {
        done(reject, new Error("callback missing code"));
        return;
      }
      done(resolve, { code, state: u.searchParams.get("state"), redirectUri: `http://127.0.0.1:${server.address().port}/callback` });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const timer = setTimeout(() => {
        server.close(() => reject(new Error("authorization timed out")));
      }, timeoutMs || 5 * 60_000);
      if (typeof timer.unref === "function") timer.unref();
      try {
        run(`http://127.0.0.1:${port}/callback`, () => server.close(() => reject(new Error("authorization cancelled"))));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

// --- Token endpoint ------------------------------------------------------------

async function exchangeCode(tokenEndpoint, { clientId, code, verifier, redirectUri }, fetchLike) {
  return tokenRequest(tokenEndpoint, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: clientId,
  }, fetchLike);
}

async function refreshTokens(tokenEndpoint, { clientId, refreshToken }, fetchLike) {
  return tokenRequest(tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  }, fetchLike);
}

async function tokenRequest(tokenEndpoint, body, fetchLike) {
  const doFetch = fetchLike || globalThis.fetch;
  const res = await doFetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`token endpoint ${res.status}: ${json.error || "unknown error"}`);
  }
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw new Error("token response missing access_token");
  }
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiresAt: Date.now() + (typeof json.expires_in === "number" ? json.expires_in * 1000 : 3600_000),
    scope: json.scope,
  };
}

module.exports = {
  createPkce,
  randomState,
  fetchJson,
  discoverProtectedResource,
  discoverIssuer,
  buildAuthorizeUrl,
  withLoopbackRedirect,
  exchangeCode,
  refreshTokens,
  AUTH_COMPLETE_HTML,
};
