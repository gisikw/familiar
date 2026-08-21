import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CODEX_USAGE_URL, CodexUsagePoller, fetchCodexUsage, formatReset, formatWindow,
  parseCodexHeaders, parseCodexUsage, readCodexCredential, type CodexUsage,
} from "./openai-codex-usage.ts";

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures/codex-usage-redacted.json"), "utf8"));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("Codex quota schema", () => {
  test("parses direct endpoint windows by duration and excludes other allowance families", () => {
    const usage = parseCodexUsage(fixture, 1_000)!;
    expect(usage.plan).toBe("example-plan");
    expect(usage.windows).toHaveLength(2);
    expect(usage.windows[0]).toEqual({ usedPercent: 15, windowSeconds: 604800, resetAt: 1787337197000 });
    expect(usage.windows[1].resetAt).toBe(3_601_000);
    expect(usage.windows.some((w) => w.usedPercent === 99)).toBe(false);
  });

  test("fails closed on malformed or changed schema", () => {
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 101, limit_window_seconds: 1 } } })).toBeNull();
    expect(parseCodexUsage({ credits: { balance: "100" } })).toBeNull();
  });

  test("parses x-codex headers but not API RPM/TPM or Anthropic headers", () => {
    const usage = parseCodexHeaders({
      "X-Codex-Primary-Used-Percent": "25",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "200",
      "x-ratelimit-remaining-tokens": "1234",
      "anthropic-ratelimit-unified-5h-utilization": "0.9",
    }, 0)!;
    expect(usage).toEqual({ source: "headers", fetchedAt: 0, windows: [{ usedPercent: 25, windowSeconds: 18000, resetAt: 200000 }] });
    expect(parseCodexHeaders({ "x-ratelimit-limit-requests": "500" })).toBeNull();
  });
});

describe("pi OAuth lookup and HTTP adapter", () => {
  test("projects only access/account and rejects stale, permissive, or absent auth", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-")); dirs.push(dir);
    const auth = path.join(dir, "auth.json");
    const sentinel = "REFRESH_MUST_NOT_ESCAPE";
    fs.writeFileSync(auth, JSON.stringify({ "openai-codex": { type: "oauth", access: "ACCESS", accountId: "ACCOUNT", expires: 100_000, refresh: sentinel } }), { mode: 0o600 });
    const projected = readCodexCredential(auth, 0);
    expect(projected).toEqual({ access: "ACCESS", accountId: "ACCOUNT" });
    expect(JSON.stringify(projected)).not.toContain(sentinel);
    expect(readCodexCredential(auth, 50_000)).toBeNull();
    fs.chmodSync(auth, 0o644);
    expect(readCodexCredential(auth, 0)).toBeNull();
    expect(readCodexCredential(path.join(dir, "missing"), 0)).toBeNull();
  });

  test("uses exact read-only request and redacts failures", async () => {
    let init: RequestInit | undefined;
    const usage = await fetchCodexUsage({ access: "SECRET_ACCESS", accountId: "SECRET_ACCOUNT" }, async (url, got) => {
      expect(url).toBe(CODEX_USAGE_URL); init = got;
      return new Response(JSON.stringify(fixture), { status: 200 });
    }, 1_000);
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string,string>).Authorization).toBe("Bearer SECRET_ACCESS");
    expect(usage.windows[0].usedPercent).toBe(15);
    const error = await fetchCodexUsage({ access: "SECRET_ACCESS", accountId: "SECRET_ACCOUNT" }, async () =>
      new Response("SECRET_BODY", { status: 401 })).catch(String);
    expect(error).toContain("HTTP 401");
    expect(error).not.toContain("SECRET_ACCESS");
    expect(error).not.toContain("SECRET_ACCOUNT");
    expect(error).not.toContain("SECRET_BODY");
  });

  test("aborts a bounded request", async () => {
    let aborted = false;
    const result = await fetchCodexUsage({ access: "a", accountId: "b" }, async (_url, init) =>
      new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      })), 0, 5).catch(String);
    expect(aborted).toBe(true);
    expect(result).toContain("aborted");
  });
});

describe("polling and formatting", () => {
  test("is single-flight, five-minute bounded, and retains visibly stale data", async () => {
    let now = 0, calls = 0, resolve!: (value: CodexUsage) => void;
    let request = () => { calls++; return new Promise<CodexUsage>((r) => { resolve = r; }); };
    const poller = new CodexUsagePoller(() => ({ access: "a", accountId: "b" }), () => request(), () => now);
    const a = poller.poll(), b = poller.poll();
    expect(calls).toBe(1);
    resolve({ source: "endpoint", fetchedAt: 0, windows: [{ usedPercent: 10, windowSeconds: 18000 }] });
    expect(await a).toBe(await b);
    await poller.poll(); expect(calls).toBe(1);
    now = 300_000;
    request = async () => { calls++; throw new Error("offline SECRET"); };
    expect((await poller.poll())?.windows[0].usedPercent).toBe(10);
    expect(poller.stale).toBe(true);
    expect(calls).toBe(2);
  });

  test("bootstrap without auth does not request", async () => {
    let calls = 0;
    const poller = new CodexUsagePoller(() => null, async () => { calls++; throw new Error(); });
    expect(await poller.poll()).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("formats actual window/reset durations", () => {
    expect(formatWindow(18000)).toBe("5h");
    expect(formatWindow(604800)).toBe("1w");
    expect(formatReset(3_601_000, 1_000)).toBe("1h");
    expect(formatReset(1_000, 1_000)).toBe("now");
  });
});
