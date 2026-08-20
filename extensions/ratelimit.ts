import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { debugLog, errorLog } from "./lib/debug.ts";

/* ============================================================================
 * RATELIMIT — surface Anthropic subscription utilization in pi's footer
 * ============================================================================
 *
 * Successful Anthropic API responses carry `anthropic-ratelimit-*` headers for
 * free (and `retry-after` on 429s). When pi talks to the tiamat gateway these
 * ride every response, so we can show live 5h/7d utilization without polling.
 *
 * HOW WE SEE HEADERS — the clean way (no fetch monkeypatching):
 *   pi exposes `after_provider_response { status, headers }`, fired after the
 *   HTTP response is received and before its stream body is consumed. `headers`
 *   is a normalized `Record<string,string>`. That is exactly the hook this
 *   feature needs — we never touch the response, only read it. (Header
 *   availability is provider/transport dependent; non-gateway or header-less
 *   providers simply yield nothing and we render nothing.)
 *
 * BEHAVIOR:
 *   - capture anthropic-ratelimit-* + retry-after on every response
 *   - cache the latest snapshot in memory and to state/ratelimit.json (atomic)
 *   - footer: compact "5h 8% · 7d 53%"; loud (warning/error) when the unified
 *     status is not "allowed" or a retry-after appears
 *   - degrade silently: no headers => no footer, never throw
 *   - debug via lib/debug.ts, never console noise
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

const STATE_FILE =
  process.env.FAMILIAR_RATELIMIT_PATH ||
  (process.env.FAMILIAR_LOG_PATH
    ? path.join(path.dirname(process.env.FAMILIAR_LOG_PATH), "ratelimit.json")
    : path.join(REPO, "state", "ratelimit.json"));

const STATUS_KEY = "ratelimit";

interface Snapshot {
  /** epoch ms when captured */
  at: number;
  /** HTTP status of the response the headers came from */
  httpStatus: number;
  /** anthropic-ratelimit-unified-status, e.g. "allowed" | "allowed_warning" | ... */
  unifiedStatus?: string;
  /** 0..1 utilization for the rolling 5h window */
  util5h?: number;
  /** 0..1 utilization for the rolling 7d window */
  util7d?: number;
  /** retry-after seconds, present on 429s */
  retryAfter?: number;
  /** every captured anthropic-ratelimit-* header, verbatim (for audit/debug) */
  raw: Record<string, string>;
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const pct = (u: number | undefined): string | undefined =>
  u === undefined ? undefined : `${Math.round(u * 100)}%`;

/** Pull the ratelimit story out of a normalized header map. Returns null when
 * nothing relevant is present (non-gateway provider, older response, etc). */
function extract(status: number, headers: Record<string, string>): Snapshot | null {
  // Normalize keys to lowercase; pi already lowercases, but be defensive so a
  // future transport change can't silently blind us.
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;

  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.startsWith("anthropic-ratelimit-")) raw[k] = v;
  }
  const retryAfter = num(h["retry-after"]);
  if (Object.keys(raw).length === 0 && retryAfter === undefined) return null;

  return {
    at: Date.now(),
    httpStatus: status,
    unifiedStatus: raw["anthropic-ratelimit-unified-status"],
    util5h: num(raw["anthropic-ratelimit-unified-5h-utilization"]),
    util7d: num(raw["anthropic-ratelimit-unified-7d-utilization"]),
    retryAfter,
    raw,
  };
}

type Tone = "dim" | "warning" | "error";

/** Decide how loud the footer should be. retry-after or a non-allowed unified
 * status is loud; heavy utilization is a soft warning. */
function tone(s: Snapshot): Tone {
  if (s.retryAfter !== undefined || s.httpStatus === 429) return "error";
  if (s.unifiedStatus && s.unifiedStatus !== "allowed") {
    return s.unifiedStatus.includes("warning") ? "warning" : "error";
  }
  const peak = Math.max(s.util5h ?? 0, s.util7d ?? 0);
  if (peak >= 0.9) return "warning";
  return "dim";
}

/** Build the compact footer body, e.g. "5h 8% · 7d 53%". Returns undefined when
 * there is nothing worth showing. */
function body(s: Snapshot): string | undefined {
  const parts: string[] = [];
  const p5 = pct(s.util5h);
  const p7 = pct(s.util7d);
  if (p5) parts.push(`5h ${p5}`);
  if (p7) parts.push(`7d ${p7}`);
  let text = parts.join(" · ");

  if (s.retryAfter !== undefined) {
    const wait = `retry ${s.retryAfter}s`;
    text = text ? `${text} · ${wait}` : wait;
  } else if (s.unifiedStatus && s.unifiedStatus !== "allowed") {
    text = text ? `${text} · ${s.unifiedStatus}` : s.unifiedStatus;
  }
  return text || undefined;
}

export default function (pi: ExtensionAPI) {
  let latest: Snapshot | undefined;
  let lastRendered = "";
  let ctxRef: ExtensionContext | undefined;

  const persist = (s: Snapshot) => {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const tmp = `${STATE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
      errorLog("ratelimit", { persistError: String(err) });
    }
  };

  const loadPersisted = (): Snapshot | undefined => {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as Snapshot;
    } catch {
      return undefined;
    }
  };

  /** Render the current snapshot to the footer, in place, only when it changed. */
  const render = () => {
    if (!ctxRef?.hasUI || !latest) return;
    const text = body(latest);
    if (!text) return;
    const t = tone(latest);
    const theme = ctxRef.ui.theme;
    const glyph = t === "error" ? "▲ " : t === "warning" ? "△ " : "";
    const painted = theme.fg(t, `${glyph}${text}`);
    if (painted === lastRendered) return;
    lastRendered = painted;
    ctxRef.ui.setStatus(STATUS_KEY, painted);
  };

  // Restore the last snapshot on session start so the footer isn't blank until
  // the first response of the new session lands.
  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    if (!latest) latest = loadPersisted();
    render();
  });

  pi.on("after_provider_response", async (event, ctx) => {
    ctxRef = ctx;
    try {
      const snap = extract(event.status, event.headers ?? {});
      if (!snap) return; // non-gateway / header-less provider: show nothing.
      latest = snap;
      persist(snap);
      debugLog("ratelimit", {
        httpStatus: snap.httpStatus,
        unifiedStatus: snap.unifiedStatus,
        util5h: snap.util5h,
        util7d: snap.util7d,
        retryAfter: snap.retryAfter,
      });
      render();
    } catch (err) {
      // Never let footer bookkeeping break a real response.
      errorLog("ratelimit", { handlerError: String(err) });
    }
  });
}
