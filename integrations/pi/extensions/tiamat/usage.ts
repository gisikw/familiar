export interface TiamatUsageWindow {
  name: string;
  used: string;
  resetsIn: string;
  resetsInSeconds: number;
}

export interface TiamatProviderUsage {
  usage?: { windows?: TiamatUsageWindow[] };
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
    return Array.isArray(windows) && windows.every((window) => {
      if (!window || typeof window !== "object") return false;
      const item = window as Record<string, unknown>;
      return typeof item.name === "string" && typeof item.used === "string" &&
        typeof item.resetsIn === "string" && typeof item.resetsInSeconds === "number";
    });
  });
}

/** Recover the router provider id from tiamat-<wire family>-<provider id>. */
export function providerId(piProvider: string | undefined): string | undefined {
  const match = piProvider?.match(/^tiamat-(?:anthropic|openai|responses)-(.+)$/);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
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
export function formatReset(resetsInSeconds: number, now = Date.now(), timeZone?: string): string | undefined {
  if (!Number.isFinite(resetsInSeconds) || resetsInSeconds <= 0) return undefined;
  if (resetsInSeconds < RELATIVE_CUTOFF_SECONDS) {
    const hours = Math.floor(resetsInSeconds / 3600);
    const minutes = Math.round((resetsInSeconds % 3600) / 60);
    if (hours === 0) return `${Math.max(minutes, 1)}m`;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  try {
    const reset = new Date(now + resetsInSeconds * 1000);
    const zone = timeZone || process.env.FAMILIAR_TIAMAT_DISPLAY_TZ || undefined;
    const text = new Intl.DateTimeFormat("en-US", {
      weekday: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: zone,
    }).format(reset);
    return text.replace(", ", " ").replaceAll(" AM", "am").replaceAll(" PM", "pm");
  } catch { return undefined; }
}

export function formatUsage(id: string, windows: TiamatUsageWindow[], stale: boolean, now = Date.now(), timeZone?: string): { text: string; tone: UsageTone } | undefined {
  if (!windows.length) return undefined;
  let peak = 0;
  const parts = windows.map((window) => {
    const percent = usedPercent(window.used);
    if (percent !== undefined) peak = Math.max(peak, percent);
    const reset = formatReset(window.resetsInSeconds, now, timeZone);
    const shown = percent === undefined ? window.used : `${Math.round(percent)}%`;
    return `${windowLabel(window.name)} ${shown}${reset ? ` ${GLYPH_REFRESH}${reset}` : ""}`;
  });
  const tone: UsageTone = peak >= 100 ? "error" : stale || peak >= 90 ? "warning" : "dim";
  const glyph = tone === "error" ? `${GLYPH_ALERT} ` : tone === "warning" ? `${GLYPH_ALERT_OUTLINE} ` : "";
  return { text: `${glyph}${providerLabel(id)} ${parts.join(" · ")}${stale ? " · stale" : ""}`, tone };
}
