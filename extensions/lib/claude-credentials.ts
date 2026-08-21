import * as fs from "node:fs";
import * as path from "node:path";

export type ClaudeCredential =
  | { kind: "credentials-json"; document: Record<string, unknown>; setting: string }
  | { kind: "oauth-token"; token: string; setting: string };

const JSON_SETTING = "anthropic.claude_credentials_json";
const TOKEN_SETTING = "anthropic.claude_oauth_token";
const LEGACY_SETTING = "FAMILIAR_ANTHROPIC_OAUTH (legacy)";

function parseCredentialsJson(raw: string, setting: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`familiar: ${setting} must be valid Claude credentials JSON (value suppressed)`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`familiar: ${setting} must be a Claude credentials JSON object (value suppressed)`);
  }
  const outer = parsed as Record<string, unknown>;
  const inner = "claudeAiOauth" in outer ? outer.claudeAiOauth : outer;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
    throw new Error(`familiar: ${setting} has no claudeAiOauth credential object (value suppressed)`);
  }
  const oauth = inner as Record<string, unknown>;
  if (typeof oauth.accessToken !== "string" || oauth.accessToken.trim() === "" ||
      typeof oauth.refreshToken !== "string" || typeof oauth.expiresAt !== "number") {
    throw new Error(`familiar: ${setting} must contain accessToken (string), refreshToken (string), and expiresAt (number) (values suppressed)`);
  }
  return "claudeAiOauth" in outer ? outer : { claudeAiOauth: outer };
}

export function resolveClaudeCredential(env: NodeJS.ProcessEnv = process.env): ClaudeCredential | null {
  let json = env.FAMILIAR_ANTHROPIC_CLAUDE_CREDENTIALS_JSON;
  const upstreamToken = env.CLAUDE_CODE_OAUTH_TOKEN;
  const familiarToken = env.FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN;
  let token = upstreamToken ?? familiarToken;
  let legacy = env.FAMILIAR_ANTHROPIC_OAUTH;
  // The loader records ambient provenance. If an ambient credential form exists,
  // it wins over a different form loaded from TOML, just like every other key.
  const hasProvenance = env._FAMILIAR_CONFIG_EXPLICIT_ENV !== undefined;
  const explicit = new Set((env._FAMILIAR_CONFIG_EXPLICIT_ENV ?? "").split(":").filter(Boolean));
  const upstreamIsAmbient = !hasProvenance || explicit.has("CLAUDE_CODE_OAUTH_TOKEN");
  const familiarIsAmbient = !hasProvenance || explicit.has("FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN");
  if (upstreamToken !== undefined && familiarToken !== undefined &&
      upstreamIsAmbient && familiarIsAmbient && upstreamToken !== familiarToken) {
    throw new Error("familiar: CLAUDE_CODE_OAUTH_TOKEN conflicts with FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN (values suppressed)");
  }
  const explicitJson = explicit.has("FAMILIAR_ANTHROPIC_CLAUDE_CREDENTIALS_JSON");
  const explicitToken = explicit.has("CLAUDE_CODE_OAUTH_TOKEN") || explicit.has("FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN");
  const explicitLegacy = explicit.has("FAMILIAR_ANTHROPIC_OAUTH");
  if (explicitJson || explicitToken || explicitLegacy) {
    if (!explicitJson) json = undefined;
    if (!explicitToken) token = undefined;
    if (!explicitLegacy) legacy = undefined;
  }
  const present = [json, token, legacy].filter((v) => v !== undefined).length;
  if (present > 1) {
    throw new Error(`familiar: configure exactly one of ${JSON_SETTING}, ${TOKEN_SETTING}, or ${LEGACY_SETTING}`);
  }
  if (token !== undefined) {
    if (token.trim() === "") throw new Error(`familiar: ${TOKEN_SETTING} must be a non-empty string (value suppressed)`);
    return { kind: "oauth-token", token, setting: TOKEN_SETTING };
  }
  if (json !== undefined) return { kind: "credentials-json", document: parseCredentialsJson(json, JSON_SETTING), setting: JSON_SETTING };
  if (legacy !== undefined) return { kind: "credentials-json", document: parseCredentialsJson(legacy, LEGACY_SETTING), setting: LEGACY_SETTING };
  return null;
}

export function materializeClaudeCredentials(credential: ClaudeCredential, dir: string): void {
  if (credential.kind !== "credentials-json") return;
  const file = path.join(dir, ".credentials.json");
  fs.writeFileSync(file, JSON.stringify(credential.document), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
