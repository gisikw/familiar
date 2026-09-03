// Unit tests for the generic OIDC native-app module. bun test oidc.test.js
import { describe, expect, test } from "bun:test";
import {
  buildAuthorizeUrl,
  createPkce,
  discoverIssuer,
  discoverProtectedResource,
  exchangeCode,
  refreshTokens,
  withLoopbackRedirect,
} from "./oidc.js";

const fetchJson = (obj, status = 200) => async () => ({ ok: status === 200, status, json: async () => obj });

describe("PKCE", () => {
  test("verifier is high-entropy and challenge is its S256 digest", () => {
    const { verifier, challenge, method } = createPkce(() => Buffer.alloc(32, 7));
    expect(method).toBe("S256");
    expect(verifier).toHaveLength(43); // 32 bytes base64url
    // Deterministic check: sha256 of the all-7 verifier, base64url.
    const { createHash } = require("node:crypto");
    const want = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(want);
  });
});

describe("discovery", () => {
  test("protected resource metadata yields the first authorization server", async () => {
    const issuer = await discoverProtectedResource(
      "https://familiar.example",
      fetchJson({ authorization_servers: ["https://id.example", "https://other.example"] }),
    );
    expect(issuer).toBe("https://id.example");
  });

  test("absent or broken advertisement degrades to null, never throws", async () => {
    expect(await discoverProtectedResource("https://familiar.example", async () => ({ ok: false, status: 404 }))).toBeNull();
    expect(await discoverProtectedResource("https://familiar.example", async () => { throw new Error("no dns"); })).toBeNull();
    expect(await discoverProtectedResource("https://familiar.example", fetchJson({}))).toBeNull();
  });

  test("issuer discovery validates required endpoints", async () => {
    const doc = await discoverIssuer("https://id.example/", fetchJson({
      authorization_endpoint: "https://id.example/auth",
      token_endpoint: "https://id.example/token",
    }));
    expect(doc.authorization_endpoint).toBe("https://id.example/auth");
    expect(discoverIssuer("https://id.example", fetchJson({ authorization_endpoint: "https://x" }))).rejects.toThrow("token_endpoint");
  });
});

describe("authorize URL", () => {
  test("carries PKCE + state + nonce, S256 method", () => {
    const url = new URL(buildAuthorizeUrl("https://id.example/auth", {
      clientId: "familiar-desktop",
      redirectUri: "http://127.0.0.1:54321/callback",
      scope: "openid profile email offline_access",
      state: "st",
      nonce: "no",
      codeChallenge: "cc",
    }));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("familiar-desktop");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("cc");
    expect(url.searchParams.get("state")).toBe("st");
  });
});

describe("token exchange + refresh", () => {
  test("code exchange posts form-encoded grant and maps the response", async () => {
    let seen;
    const fetchLike = async (url, init) => {
      seen = { url, body: init.body };
      return { ok: true, status: 200, json: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 600, scope: "openid" }) };
    };
    const tokens = await exchangeCode("https://id.example/token", {
      clientId: "cid", code: "abc", verifier: "vvv", redirectUri: "http://127.0.0.1:54321/callback",
    }, fetchLike);
    expect(seen.url).toBe("https://id.example/token");
    const params = new URLSearchParams(seen.body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code_verifier")).toBe("vvv");
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  test("refresh tolerates non-rotated refresh tokens and missing expiry", async () => {
    const fetchLike = async () => ({ ok: true, status: 200, json: async () => ({ access_token: "at2" }) });
    const tokens = await refreshTokens("https://id.example/token", { clientId: "cid", refreshToken: "rt" }, fetchLike);
    expect(tokens.accessToken).toBe("at2");
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.expiresAt).toBe(Date.now() + 3600_000);
  });

  test("provider error surfaces the error code", async () => {
    const fetchLike = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) });
    expect(refreshTokens("https://id.example/token", { clientId: "cid", refreshToken: "rt" }, fetchLike))
      .rejects.toThrow("invalid_grant");
  });
});

describe("loopback redirect", () => {
  const get = (path) =>
    fetch(`http://127.0.0.1:${globalThis.__port ?? 0}${path}`).catch(() => {});

  test("resolves code+state from the provider redirect and serves a completion page", async () => {
    let redirectUri;
    const pending = withLoopbackRedirect((uri) => { redirectUri = uri; }, { timeoutMs: 5000 });
    // Wait for the listener to bind by polling the port out of redirectUri.
    for (let i = 0; i < 50 && !redirectUri; i++) await new Promise((r) => setTimeout(r, 10));
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    globalThis.__port = Number(new URL(redirectUri).port);
    const res = await get("/callback?code=X&state=Y");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("close this tab");
    const result = await pending;
    expect(result.code).toBe("X");
    expect(result.state).toBe("Y");
    expect(result.redirectUri).toBe(redirectUri);
  });

  test("provider-reported error rejects with the error code", async () => {
    let redirectUri;
    const pending = withLoopbackRedirect((uri) => { redirectUri = uri; }, { timeoutMs: 5000 });
    for (let i = 0; i < 50 && !redirectUri; i++) await new Promise((r) => setTimeout(r, 10));
    globalThis.__port = Number(new URL(redirectUri).port);
    await get("/callback?error=access_denied");
    expect(pending).rejects.toThrow("access_denied");
  });

  test("unknown paths get a 404 and do not settle the promise", async () => {
    let redirectUri;
    const pending = withLoopbackRedirect((uri) => { redirectUri = uri; }, { timeoutMs: 3000 });
    for (let i = 0; i < 50 && !redirectUri; i++) await new Promise((r) => setTimeout(r, 10));
    globalThis.__port = Number(new URL(redirectUri).port);
    const res = await get("/nope");
    expect(res.status).toBe(404);
    // Let the timeout fire and clean up.
    await expect(pending).rejects.toThrow("timed out");
  });
});
