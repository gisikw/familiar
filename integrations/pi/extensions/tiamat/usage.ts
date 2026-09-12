import {
  catalogToProviderGroups,
  routeForRecord,
  type TiamatCatalogRecord,
} from "./catalog.ts";

export interface TiamatUsageWindow {
  name: string;
  used: string;
  resetsIn: string;
  resetsInSeconds: number;
}

/** OpenRouter-style per-key budget (USD). limit/reset only when the key has a cap. */
export interface TiamatUsageCredits {
  remaining?: number;
  limit?: number;
  reset?: string;
  resetsInSeconds?: number;
  used?: number;
  unit?: string;
}

/** OpenRouter account-level prepaid balance (USD). */
export interface TiamatUsageBalance {
  total?: number;
  used?: number;
  remaining?: number;
  unit?: string;
}

export interface TiamatProviderUsage {
  usage?: {
    windows?: TiamatUsageWindow[];
    credits?: TiamatUsageCredits;
    balance?: TiamatUsageBalance;
    fetchedAt?: string;
  };
}

export type TiamatProviders = Record<string, TiamatProviderUsage>;
export type UsageTone = "dim" | "warning" | "error";

export function isProviders(value: unknown): value is TiamatProviders {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((provider) => {
    if (!provider || typeof provider !== "object") return false;
    const usage = (provider as Record<string, unknown>).usage;
    if (usage === undefined) return true;
    if (!usage || typeof usage !== "object") return false;
    const windows = (usage as Record<string, unknown>).windows;
    if (windows === undefined) return true;
    return (
      Array.isArray(windows) &&
      windows.every((window) => {
        if (!window || typeof window !== "object") return false;
        const item = window as Record<string, unknown>;
        return (
          typeof item.name === "string" &&
          typeof item.used === "string" &&
          typeof item.resetsIn === "string" &&
          typeof item.resetsInSeconds === "number"
        );
      })
    );
  });
}

/** Recover the router provider id from tiamat-<wire family>-<provider id>. */
export function providerId(piProvider: string | undefined): string | undefined {
  const match = piProvider?.match(
    /^tiamat-(?:anthropic|openai|responses)-(.+)$/,
  );
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/* The browser webfont is double-patched with full plain-Unicode symbol
 * coverage for the selected terminal ranges, including these glyphs. */
const GLYPH_REFRESH = "↻";
const GLYPH_ALERT_OUTLINE = "△";
const GLYPH_ALERT = "▲";

const usedPercent = (used: string): number | undefined => {
  const parsed = Number.parseFloat(used.replace(/%\s*$/, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
};

function providerLabel(id: string): string {
  if (id.startsWith("claude")) return "claude";
  if (id.startsWith("codex")) return "codex";
  if (id.startsWith("llama")) return "llama";
  return id.replace(/-(?:personal|work)$/, "");
}

function windowLabel(name: string): string {
  if (name === "session") return "5h";
  if (name === "weekly") return "7d";
  return name;
}

const RELATIVE_CUTOFF_SECONDS = 12 * 3600;

/** Claude-desktop style: relative under 12h ("2h 29m"), absolute weekday+time beyond. */
export function formatReset(
  resetsInSeconds: number,
  now = Date.now(),
  timeZone?: string,
): string | undefined {
  if (!Number.isFinite(resetsInSeconds) || resetsInSeconds <= 0)
    return undefined;
  if (resetsInSeconds < RELATIVE_CUTOFF_SECONDS) {
    const hours = Math.floor(resetsInSeconds / 3600);
    const minutes = Math.round((resetsInSeconds % 3600) / 60);
    if (hours === 0) return `${Math.max(minutes, 1)}m`;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  try {
    const reset = new Date(now + resetsInSeconds * 1000);
    const zone =
      timeZone || process.env.FAMILIAR_TIAMAT_DISPLAY_TZ || undefined;
    const text = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: zone,
    }).format(reset);
    return text
      .replace(", ", " ")
      .replaceAll(" AM", "am")
      .replaceAll(" PM", "pm");
  } catch {
    return undefined;
  }
}

export function formatUsage(
  id: string,
  windows: TiamatUsageWindow[],
  stale: boolean,
  now = Date.now(),
  timeZone?: string,
): { text: string; tone: UsageTone } | undefined {
  if (!windows.length) return undefined;
  let peak = 0;
  const parts = windows.map((window) => {
    const percent = usedPercent(window.used);
    if (percent !== undefined) peak = Math.max(peak, percent);
    const reset = formatReset(window.resetsInSeconds, now, timeZone);
    const shown =
      percent === undefined ? window.used : `${Math.round(percent)}%`;
    return `${windowLabel(window.name)} ${shown}${reset ? ` ${GLYPH_REFRESH}${reset}` : ""}`;
  });
  const tone: UsageTone =
    peak >= 100 ? "error" : stale || peak >= 90 ? "warning" : "dim";
  const glyph =
    tone === "error"
      ? `${GLYPH_ALERT} `
      : tone === "warning"
        ? `${GLYPH_ALERT_OUTLINE} `
        : "";
  return {
    text: `${glyph}${providerLabel(id)} ${parts.join(" · ")}${stale ? " · stale" : ""}`,
    tone,
  };
}

const fmtMoney = (value: number | undefined): string | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? `$${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2)}`
    : undefined;

/**
 * Budget-style usage (OpenRouter): per-key credit cap with optional reset
 * policy, plus account balance. Renders e.g.:
 *
 *   OR $9.77/$10 ↻8h 13m · $24.77 acct     (key capped, reset configured)
 *   OR $6.20/$10 · $18.80 acct             (key capped, no reset)
 *   OR $24.77 acct                         (unlimited key: balance only)
 *
 * Tone: error at <10% key budget remaining (or <10% of balance when no cap),
 * warning at <25% or when stale, dim otherwise.
 */
export function formatBudgetUsage(
  id: string,
  usage: TiamatProviderUsage["usage"],
  stale: boolean,
  now = Date.now(),
  timeZone?: string,
): { text: string; tone: UsageTone } | undefined {
  if (!usage) return undefined;
  const { credits, balance } = usage;
  if (!credits && !balance) return undefined;

  const parts: string[] = [];
  let budgetFractionUsed: number | undefined;
  let balanceFractionUsed: number | undefined;

  if (credits?.limit !== undefined) {
    // Numerator is *used* budget (counts up, consistent with the % convention
    // on windowed providers); fall back to limit - remaining when the API
    // omits usage.
    const spent =
      credits.used ??
      (credits.remaining !== undefined
        ? credits.limit - credits.remaining
        : undefined);
    if (spent !== undefined)
      parts.push(`${fmtMoney(spent)}/${fmtMoney(credits.limit)}`);
    else
      parts.push(`${fmtMoney(credits.remaining)}/${fmtMoney(credits.limit)}`);
    if (credits.limit > 0 && credits.remaining !== undefined) {
      budgetFractionUsed = 1 - credits.remaining / credits.limit;
    }
    if (credits.resetsInSeconds !== undefined) {
      const reset = formatReset(credits.resetsInSeconds, now, timeZone);
      if (reset) parts[parts.length - 1] += ` ${GLYPH_REFRESH}${reset}`;
    }
  } else if (credits?.remaining !== undefined) {
    // Degenerate: remaining reported but no limit to anchor it.
    parts.push(fmtMoney(credits.remaining));
  }
  if (balance?.remaining !== undefined) {
    parts.push(`${fmtMoney(balance.remaining)} acct`);
    if (balance.total && balance.total > 0 && balance.used !== undefined) {
      balanceFractionUsed = balance.used / balance.total;
    }
  }
  if (!parts.length) return undefined;
  const label = id.startsWith("openrouter") ? "OR" : providerLabel(id);

  const keyFractionUsed =
    budgetFractionUsed ??
    (balanceFractionUsed !== undefined ? balanceFractionUsed : undefined);
  const tone: UsageTone =
    (keyFractionUsed !== undefined && keyFractionUsed >= 0.9) ||
    (balanceFractionUsed !== undefined && balanceFractionUsed >= 0.9)
      ? "error"
      : stale ||
          (keyFractionUsed !== undefined && keyFractionUsed >= 0.75) ||
          (balanceFractionUsed !== undefined && balanceFractionUsed >= 0.75)
        ? "warning"
        : "dim";
  const glyph =
    tone === "error"
      ? `${GLYPH_ALERT} `
      : tone === "warning"
        ? `${GLYPH_ALERT_OUTLINE} `
        : "";
  return {
    text: `${glyph}${label} ${parts.join(" · ")}${stale ? " · stale" : ""}`,
    tone,
  };
}

/* ==========================================================================
 * In-process projection of the registered Tiamat providers for a UI bridge.
 *
 * `familiar-ui` renders a model picker grouped by *registered provider* (the
 * Tiamat account label, verbatim) and shows only metadata the router itself
 * publishes on `GET /tiamat/v1/providers` and `GET /tiamat/v1/models`: kind,
 * locality, usage windows / spend / credits, and per-model availability. No
 * upstream vendor identity is inferred from a model id, no prose is authored
 * here, and nothing with a credential or a base URL leaves this module.
 *
 * Discovery mirrors `familiar:background:discover`: a bridge emits
 * `familiar:tiamat:discover` with an `accept(port)` callback and reads the
 * port synchronously while building a snapshot. The bridge is told to rebuild
 * through `familiar:tiamat:changed` after every catalog reconcile or usage
 * poll. Both events are process-local; the browser cannot reach them.
 * ========================================================================== */

export interface TiamatPortUsageWindow {
  name: string;
  /** Percentage used, 0–100, when the router reported a parseable figure. */
  used: number | null;
  /** The router's human-compact form, e.g. "7%". */
  usedText: string;
  resetsIn: string;
  resetsInSeconds?: number;
}

export interface TiamatPortUsage {
  windows: TiamatPortUsageWindow[];
  spend?: { period: string; amount: string; currency: string };
  credits?: { balance: string };
  /** Unix ms of the router's own snapshot; absent when it reported none. */
  fetchedAt?: number;
}

export interface TiamatPortModel {
  id: string;
  /** Exact generated Pi route; account/model alone can be wire-ambiguous. */
  route: string;
  availability: "available" | "degraded" | "unavailable";
  reason?: string;
  resetsIn?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
}

export interface TiamatPortProvider {
  /** The registered Tiamat provider id, verbatim (e.g. `claude-code-personal`). */
  id: string;
  kind?: "oauth-client" | "api-key";
  locality?: "remote" | "local";
  /** Pi provider ids registered for this account (one per wire family). */
  members: string[];
  /** Every catalogue model on this account, including ones Pi does not register. */
  models: TiamatPortModel[];
  /** `null` when the router reported no telemetry (`usage: {}`). */
  usage: TiamatPortUsage | null;
}

export interface TiamatActivationResult {
  ok: boolean;
  error?: "busy" | "not_found" | "unavailable" | "forbidden" | "failed";
}

export interface TiamatPort {
  providers(): TiamatPortProvider[];
  /** Atomically materialize and select an exact generated route/model. */
  activate(provider: string, modelId: string): Promise<TiamatActivationResult>;
  /** Unix ms of the last successful `/tiamat/v1/providers` poll, or `null`. */
  usageRefreshedAt(): number | null;
}

const PORT_MAX_PROVIDERS = 64;
const PORT_MAX_MODELS = 256;
const PORT_MAX_WINDOWS = 8;
const PORT_SHORT = 256;

const clip = (value: unknown, max = PORT_SHORT): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value.slice(0, max)
    : undefined;

const clampPercent = (used: string): number | null => {
  const parsed = usedPercent(used);
  return parsed === undefined ? null : Math.max(0, Math.min(100, parsed));
};

const timestamp = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

function projectUsage(raw: unknown): TiamatPortUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const windows: TiamatPortUsageWindow[] = [];
  if (Array.isArray(usage.windows)) {
    for (const item of usage.windows.slice(0, PORT_MAX_WINDOWS)) {
      if (!item || typeof item !== "object") continue;
      const w = item as Record<string, unknown>;
      const name = clip(w.name, 64);
      const usedText = clip(w.used, 32);
      if (!name || usedText === undefined) continue;
      windows.push({
        name,
        used: clampPercent(usedText),
        usedText,
        resetsIn: clip(w.resetsIn, 32) ?? "",
        ...(typeof w.resetsInSeconds === "number" &&
        Number.isFinite(w.resetsInSeconds)
          ? { resetsInSeconds: w.resetsInSeconds }
          : {}),
      });
    }
  }
  let spend: TiamatPortUsage["spend"];
  if (usage.spend && typeof usage.spend === "object") {
    const s = usage.spend as Record<string, unknown>;
    const amount =
      typeof s.amount === "number" ? String(s.amount) : clip(s.amount, 32);
    const period = clip(s.period, 32);
    const currency = clip(s.currency, 8);
    if (amount && period && currency) spend = { period, amount, currency };
  }
  let credits: TiamatPortUsage["credits"];
  if (usage.credits && typeof usage.credits === "object") {
    const c = usage.credits as Record<string, unknown>;
    const balance =
      typeof c.balance === "number" ? String(c.balance) : clip(c.balance, 32);
    if (balance) credits = { balance };
  }
  const fetchedAt = timestamp(usage.fetchedAt);
  // `usage: {}` is "no telemetry", which the UI must state rather than draw as 0%.
  if (!windows.length && !spend && !credits) return null;
  return {
    windows,
    ...(spend ? { spend } : {}),
    ...(credits ? { credits } : {}),
    ...(fetchedAt === undefined ? {} : { fetchedAt }),
  };
}

/**
 * Pure projection. `providers` is the raw `/tiamat/v1/providers` body (already
 * shape-checked by `isProviders`), `catalog` the raw `/tiamat/v1/models` body,
 * and `baseUrl` is used only to recover the Pi provider ids `catalog.ts`
 * registers for each account — it is never emitted.
 */
export function projectProviders(
  providers: TiamatProviders,
  catalog: readonly TiamatCatalogRecord[],
  baseUrl: string,
): TiamatPortProvider[] {
  const groups = catalogToProviderGroups(
    catalog as TiamatCatalogRecord[],
    baseUrl,
  );
  const byAccount = new Map<string, TiamatPortProvider>();
  const ensure = (id: string): TiamatPortProvider | undefined => {
    let entry = byAccount.get(id);
    if (!entry) {
      if (byAccount.size >= PORT_MAX_PROVIDERS) return undefined;
      entry = { id, members: [], models: [], usage: null };
      byAccount.set(id, entry);
    }
    return entry;
  };
  // Catalogue order first: it is the order the router lists accounts in.
  for (const record of catalog) {
    const id = clip(record.provider);
    if (!id) continue;
    const entry = ensure(id);
    if (!entry || entry.models.length >= PORT_MAX_MODELS) continue;
    const model = clip(record.model);
    const route = clip(routeForRecord(record));
    if (
      !model ||
      !route ||
      entry.models.some((candidate) =>
        candidate.id === model && candidate.route === route
      )
    )
      continue;
    entry.models.push({
      id: model,
      route,
      availability: record.availability,
      ...(record.reason ? { reason: clip(record.reason, 64) } : {}),
      ...(record.resetsIn ? { resetsIn: clip(record.resetsIn, 32) } : {}),
      reasoning: record.reasoning ?? false,
      input: record.input?.length ? record.input : ["text"],
      contextWindow: record.context_window ?? 128_000,
    });
  }
  for (const group of groups) {
    const entry = ensure(group.tiamatProvider);
    if (entry && !entry.members.includes(group.id))
      entry.members.push(group.id);
  }
  for (const [id, raw] of Object.entries(providers)) {
    const entry = ensure(id.slice(0, PORT_SHORT));
    if (!entry) continue;
    const p = raw as Record<string, unknown>;
    if (p.kind === "oauth-client" || p.kind === "api-key") entry.kind = p.kind;
    if (p.locality === "remote" || p.locality === "local")
      entry.locality = p.locality;
    entry.usage = projectUsage(p.usage);
  }
  return [...byAccount.values()];
}
