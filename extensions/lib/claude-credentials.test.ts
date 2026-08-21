import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { materializeClaudeCredentials, resolveClaudeCredential } from "./claude-credentials.ts";

const envelope = JSON.stringify({ claudeAiOauth: { accessToken: "access-placeholder", refreshToken: "refresh-placeholder", expiresAt: 123 } });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("Claude credentials", () => {
  test("accepts and materializes explicit renewable credential JSON at 0600", () => {
    const cred = resolveClaudeCredential({ FAMILIAR_ANTHROPIC_CLAUDE_CREDENTIALS_JSON: envelope });
    expect(cred?.kind).toBe("credentials-json");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-cred-test-")); dirs.push(dir);
    materializeClaudeCredentials(cred!, dir);
    expect(fs.statSync(path.join(dir, ".credentials.json")).mode & 0o777).toBe(0o600);
  });

  test("accepts direct long-lived token without writing credentials JSON", () => {
    const cred = resolveClaudeCredential({ FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN: "token-placeholder" });
    expect(cred?.kind).toBe("oauth-token");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-cred-test-")); dirs.push(dir);
    materializeClaudeCredentials(cred!, dir);
    expect(fs.existsSync(path.join(dir, ".credentials.json"))).toBe(false);
  });

  test("ambient direct token provenance overrides file-loaded JSON form", () => {
    const cred = resolveClaudeCredential({
      _FAMILIAR_CONFIG_EXPLICIT_ENV: "CLAUDE_CODE_OAUTH_TOKEN",
      CLAUDE_CODE_OAUTH_TOKEN: "ambient-placeholder",
      FAMILIAR_ANTHROPIC_CLAUDE_CREDENTIALS_JSON: envelope,
    });
    expect(cred?.kind).toBe("oauth-token");
  });

  test("direct-token aliases reject differing ambient values but accept equal or missing aliases", () => {
    const upstream = "DO_NOT_REPORT_upstream_token";
    const familiar = "DO_NOT_REPORT_familiar_token";
    try {
      resolveClaudeCredential({
        _FAMILIAR_CONFIG_EXPLICIT_ENV: "CLAUDE_CODE_OAUTH_TOKEN:FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN",
        CLAUDE_CODE_OAUTH_TOKEN: upstream,
        FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN: familiar,
      });
      throw new Error("accepted differing aliases");
    } catch (error) {
      const message = String(error);
      expect(message).toContain("CLAUDE_CODE_OAUTH_TOKEN conflicts with FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN");
      expect(message).toContain("values suppressed");
      expect(message).not.toContain(upstream);
      expect(message).not.toContain(familiar);
    }

    const equal = resolveClaudeCredential({
      _FAMILIAR_CONFIG_EXPLICIT_ENV: "CLAUDE_CODE_OAUTH_TOKEN:FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN",
      CLAUDE_CODE_OAUTH_TOKEN: "equal-placeholder",
      FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN: "equal-placeholder",
    });
    expect(equal).toMatchObject({ kind: "oauth-token", token: "equal-placeholder" });
    expect(resolveClaudeCredential({ CLAUDE_CODE_OAUTH_TOKEN: "upstream-only" })?.kind).toBe("oauth-token");
    expect(resolveClaudeCredential({ FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN: "familiar-only" })?.kind).toBe("oauth-token");
    expect(resolveClaudeCredential({})).toBeNull();
  });

  test("legacy setting remains JSON-only and cannot misclassify a raw secret", () => {
    expect(() => resolveClaudeCredential({ FAMILIAR_ANTHROPIC_OAUTH: "not-json-placeholder" })).toThrow("FAMILIAR_ANTHROPIC_OAUTH (legacy)");
  });

  test("rejects ambiguity and malformed shapes without including contents", () => {
    const secret = "DO_NOT_REPORT_credential_value";
    for (const env of [
      { FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN: secret, FAMILIAR_ANTHROPIC_CLAUDE_CREDENTIALS_JSON: envelope },
      { FAMILIAR_ANTHROPIC_CLAUDE_CREDENTIALS_JSON: JSON.stringify({ claudeAiOauth: { accessToken: secret } }) },
    ]) {
      try { resolveClaudeCredential(env); throw new Error("accepted"); }
      catch (error) { expect(String(error)).not.toContain(secret); }
    }
  });
});
