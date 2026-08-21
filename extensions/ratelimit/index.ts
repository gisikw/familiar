import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { debugLog, errorLog } from "../lib/debug.ts";
import {
  CodexUsagePoller,
  fetchCodexUsage,
  formatReset,
  formatWindow,
  parseCodexHeaders,
  readCodexCredential,
  type CodexUsage,
} from "../lib/openai-codex-usage.ts";

/* Subscription quota only: Claude's rolling utilization headers and Codex's
 * account windows. This intentionally does not show request tokens, OpenAI API
 * RPM/TPM, generic ChatGPT allowances, credits, or code-review limits. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(path.dirname(HERE));
const STATE_FILE = process.env.FAMILIAR_RATELIMIT_PATH ||
  (process.env.FAMILIAR_LOG_PATH
    ? path.join(path.dirname(process.env.FAMILIAR_LOG_PATH), "ratelimit.json")
    : path.join(REPO, "state", "ratelimit.json"));
const STATUS_KEY = "ratelimit";

interface AnthropicSnapshot {
  at: number;
  httpStatus: number;
  unifiedStatus?: string;
  util5h?: number;
  util7d?: number;
  retryAfter?: number;
  raw: Record<string, string>;
}
interface State { anthropic?: AnthropicSnapshot; codex?: CodexUsage }
type Tone = "dim" | "warning" | "error";

const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function extractAnthropic(status: number, headers: Record<string, string>, now = Date.now()): AnthropicSnapshot | null {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (k.startsWith("anthropic-ratelimit-")) raw[k] = v;
  const retryAfter = num(h["retry-after"]);
  if (!Object.keys(raw).length && retryAfter === undefined) return null;
  return {
    at: now, httpStatus: status,
    unifiedStatus: raw["anthropic-ratelimit-unified-status"],
    util5h: num(raw["anthropic-ratelimit-unified-5h-utilization"]),
    util7d: num(raw["anthropic-ratelimit-unified-7d-utilization"]),
    retryAfter, raw,
  };
}

function anthropicTone(s: AnthropicSnapshot): Tone {
  if (s.retryAfter !== undefined || s.httpStatus === 429) return "error";
  if (s.unifiedStatus && s.unifiedStatus !== "allowed") return s.unifiedStatus.includes("warning") ? "warning" : "error";
  return Math.max(s.util5h ?? 0, s.util7d ?? 0) >= 0.9 ? "warning" : "dim";
}

export function anthropicBody(s: AnthropicSnapshot): string | undefined {
  const parts: string[] = [];
  if (s.util5h !== undefined) parts.push(`Claude 5h ${Math.round(s.util5h * 100)}% used`);
  if (s.util7d !== undefined) parts.push(`7d ${Math.round(s.util7d * 100)}% used`);
  if (s.retryAfter !== undefined) parts.push(`retry ${s.retryAfter}s`);
  else if (s.unifiedStatus && s.unifiedStatus !== "allowed") parts.push(s.unifiedStatus);
  return parts.length ? parts.join(" · ") : undefined;
}

export function codexBody(s: CodexUsage, stale: boolean, now = Date.now()): string | undefined {
  const windows = s.windows.slice(0, 2).map((w) => {
    const reset = formatReset(w.resetAt, now);
    const remaining = Math.round(100 - w.usedPercent);
    return `${formatWindow(w.windowSeconds)} ${Math.round(w.usedPercent)}% used/${remaining}% left${reset ? ` reset ${reset}` : ""}`;
  });
  return windows.length ? `Codex ${windows.join(" · ")}${stale ? " · stale" : ""}` : undefined;
}

export default function (pi: ExtensionAPI) {
  let state: State = {};
  let codexStale = false;
  let lastRendered = "";
  let ctxRef: ExtensionContext | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const persist = () => {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const tmp = `${STATE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, STATE_FILE);
    } catch (err) { errorLog("ratelimit", { persistError: String(err) }); }
  };
  const load = (): State => {
    try {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State | AnthropicSnapshot;
      return "raw" in parsed ? { anthropic: parsed as AnthropicSnapshot } : parsed;
    } catch { return {}; }
  };
  const render = () => {
    if (!ctxRef?.hasUI) return;
    const entries: Array<{ text: string; tone: Tone }> = [];
    const claude = state.anthropic && anthropicBody(state.anthropic);
    if (claude && state.anthropic) entries.push({ text: claude, tone: anthropicTone(state.anthropic) });
    const codex = state.codex && codexBody(state.codex, codexStale);
    if (codex && state.codex) {
      const peak = Math.max(...state.codex.windows.map((w) => w.usedPercent));
      entries.push({ text: codex, tone: codexStale || peak >= 90 ? "warning" : "dim" });
    }
    if (!entries.length) return;
    const tone: Tone = entries.some((e) => e.tone === "error") ? "error" : entries.some((e) => e.tone === "warning") ? "warning" : "dim";
    const glyph = tone === "error" ? "▲ " : tone === "warning" ? "△ " : "";
    const painted = ctxRef.ui.theme.fg(tone, glyph + entries.map((e) => e.text).join("  |  "));
    if (painted !== lastRendered) { lastRendered = painted; ctxRef.ui.setStatus(STATUS_KEY, painted); }
  };

  const poller = new CodexUsagePoller(readCodexCredential, (credential) => fetchCodexUsage(credential));
  const poll = () => {
    void poller.poll().then((usage) => {
      if (usage) state.codex = usage;
      codexStale = poller.stale;
      if (usage) persist();
      render();
    }).catch(() => { /* poller is defensive; never affect an agent turn */ });
  };
  const activeCodex = (ctx: ExtensionContext) => ctx.model?.provider === "openai-codex";

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    state = load();
    poller.seed(state.codex);
    render();
    if (activeCodex(ctx)) poll();
    if (!pollTimer) {
      pollTimer = setInterval(() => { if (ctxRef && activeCodex(ctxRef)) poll(); }, 5 * 60_000);
      pollTimer.unref?.();
    }
  });
  pi.on("session_shutdown", async () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  });
  pi.on("turn_end", async (_event, ctx) => {
    ctxRef = ctx;
    if (activeCodex(ctx)) poll();
  });
  pi.on("after_provider_response", async (event, ctx) => {
    ctxRef = ctx;
    try {
      const codex = parseCodexHeaders(event.headers ?? {});
      if (codex) {
        state.codex = codex;
        codexStale = false;
        poller.seed(codex, true); // fresh in-band data suppresses the fallback poll
      }
      const anthropic = extractAnthropic(event.status, event.headers ?? {});
      if (anthropic) state.anthropic = anthropic;
      if (!codex && !anthropic) return;
      persist();
      debugLog("ratelimit", { providerQuota: codex ? "codex" : "anthropic", httpStatus: event.status });
      render();
    } catch (err) { errorLog("ratelimit", { handlerError: String(err) }); }
  });
}
