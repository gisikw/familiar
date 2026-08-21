import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_POLL_MS = 5 * 60_000;
const EXPIRY_SKEW_MS = 60_000;

export interface CodexWindow {
  usedPercent: number;
  windowSeconds: number;
  resetAt?: number; // epoch ms
}

export interface CodexUsage {
  source: "headers" | "endpoint";
  fetchedAt: number;
  plan?: string;
  windows: CodexWindow[];
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v :
    typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;

function windowFrom(value: unknown, now: number): CodexWindow | undefined {
  const w = record(value);
  if (!w) return undefined;
  const used = finite(w.used_percent);
  const seconds = finite(w.limit_window_seconds);
  if (used === undefined || used < 0 || used > 100 || seconds === undefined || seconds <= 0) return undefined;
  const absolute = finite(w.reset_at);
  const relative = finite(w.reset_after_seconds);
  const resetAt = absolute !== undefined && absolute >= 0 ? absolute * 1000 :
    relative !== undefined && relative >= 0 ? now + relative * 1000 : undefined;
  return { usedPercent: used, windowSeconds: seconds, ...(resetAt === undefined ? {} : { resetAt }) };
}

/** Strictly project only the default Codex subscription windows. Other ChatGPT,
 * API RPM/TPM, token, credit, code-review and named-feature limits stay separate. */
export function parseCodexUsage(value: unknown, now = Date.now()): CodexUsage | null {
  const root = record(value);
  const rate = record(root?.rate_limit);
  if (!root || !rate) return null;
  const windows = [windowFrom(rate.primary_window, now), windowFrom(rate.secondary_window, now)]
    .filter((w): w is CodexWindow => w !== undefined);
  if (windows.length === 0) return null; // fail closed on schema drift
  return {
    source: "endpoint",
    fetchedAt: now,
    ...(typeof root.plan_type === "string" && root.plan_type.length < 64 ? { plan: root.plan_type } : {}),
    windows,
  };
}

/** Parse quota headers only; deliberately ignores OpenAI API x-ratelimit-* headers. */
export function parseCodexHeaders(headers: Record<string, string>, now = Date.now()): CodexUsage | null {
  const h: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) h[key.toLowerCase()] = value;
  const windows: CodexWindow[] = [];
  for (const name of ["primary", "secondary"]) {
    const used = finite(h[`x-codex-${name}-used-percent`]);
    const minutes = finite(h[`x-codex-${name}-window-minutes`]);
    if (used === undefined || used < 0 || used > 100 || minutes === undefined || minutes <= 0) continue;
    const resetSeconds = finite(h[`x-codex-${name}-reset-at`]);
    windows.push({
      usedPercent: used,
      windowSeconds: minutes * 60,
      ...(resetSeconds === undefined || resetSeconds < 0 ? {} : { resetAt: resetSeconds * 1000 }),
    });
  }
  return windows.length ? { source: "headers", fetchedAt: now, windows } : null;
}

export interface CodexCredential { access: string; accountId: string }

export function defaultPiAuthPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(dir, "auth.json");
}

/** Read only access/account/expiry. The refresh field is neither projected nor used. */
export function readCodexCredential(authPath = defaultPiAuthPath(), now = Date.now()): CodexCredential | null {
  try {
    const stat = fs.statSync(authPath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return null;
    const root = record(JSON.parse(fs.readFileSync(authPath, "utf8")));
    const auth = record(root?.["openai-codex"]);
    if (auth?.type !== "oauth" || typeof auth.access !== "string" || !auth.access ||
        typeof auth.accountId !== "string" || !auth.accountId) return null;
    const expires = finite(auth.expires);
    // pi OAuth expiry is epoch milliseconds. Unknown expiry is accepted for
    // compatibility; a known stale token is left for pi (the sole owner) to refresh.
    if (expires !== undefined && expires <= now + EXPIRY_SKEW_MS) return null;
    return { access: auth.access, accountId: auth.accountId };
  } catch {
    return null;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function fetchCodexUsage(
  credential: CodexCredential,
  fetchFn: FetchLike = fetch,
  now = Date.now(),
  timeoutMs = 8_000,
): Promise<CodexUsage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(CODEX_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.access}`,
        "ChatGPT-Account-Id": credential.accountId,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`codex usage HTTP ${response.status}`);
    const usage = parseCodexUsage(await response.json(), now);
    if (!usage) throw new Error("codex usage schema unavailable");
    return usage;
  } finally {
    clearTimeout(timer);
  }
}

/** Five-minute cadence and single-flight. Failures retain and mark last-known data. */
export class CodexUsagePoller {
  private lastAttempt = -Infinity;
  private pending?: Promise<CodexUsage | undefined>;
  private latest?: CodexUsage;
  stale = false;

  constructor(
    private readonly getCredential: () => CodexCredential | null,
    private readonly request: (credential: CodexCredential) => Promise<CodexUsage>,
    private readonly now: () => number = Date.now,
    private readonly cadenceMs = CODEX_POLL_MS,
  ) {}

  seed(usage: CodexUsage | undefined, fresh = false): void {
    if (usage) {
      this.latest = usage;
      this.stale = false;
      if (fresh) this.lastAttempt = this.now();
    }
  }
  value(): CodexUsage | undefined { return this.latest; }

  poll(force = false): Promise<CodexUsage | undefined> {
    if (this.pending) return this.pending;
    const now = this.now();
    if (!force && now - this.lastAttempt < this.cadenceMs) return Promise.resolve(this.latest);
    const credential = this.getCredential();
    if (!credential) return Promise.resolve(this.latest); // bootstrap without auth is silent
    this.lastAttempt = now;
    this.pending = this.request(credential).then((usage) => {
      this.latest = usage;
      this.stale = false;
      return usage;
    }).catch(() => {
      if (this.latest) this.stale = true;
      return this.latest;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
}

export function formatWindow(seconds: number): string {
  if (seconds % 604800 === 0) return `${seconds / 604800}w`;
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

export function formatReset(resetAt: number | undefined, now = Date.now()): string | undefined {
  if (resetAt === undefined) return undefined;
  const seconds = Math.max(0, Math.ceil((resetAt - now) / 1000));
  if (seconds === 0) return "now";
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.ceil(seconds / 3600)}h`;
  return `${Math.ceil(seconds / 86400)}d`;
}
