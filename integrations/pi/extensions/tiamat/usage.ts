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

export function formatUsage(id: string, windows: TiamatUsageWindow[], stale: boolean): { text: string; tone: UsageTone } | undefined {
  if (!windows.length) return undefined;
  let peak = 0;
  const parts = windows.map((window) => {
    const percent = usedPercent(window.used);
    if (percent !== undefined) peak = Math.max(peak, percent);
    return `${windowLabel(window.name)} ${percent === undefined ? window.used : `${Math.round(percent)}%`}`;
  });
  const tone: UsageTone = peak >= 100 ? "error" : stale || peak >= 90 ? "warning" : "dim";
  const glyph = tone === "error" ? "▲ " : tone === "warning" ? "△ " : "";
  return { text: `${glyph}${providerLabel(id)} ${parts.join(" · ")}${stale ? " · stale" : ""}`, tone };
}
