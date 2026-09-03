import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { errorLog, debugLog } from "../lib/debug.ts";
import {
  catalogToProviderGroups,
  etagRequiresFetch,
  isCatalog,
  normalizeBaseUrl,
  withoutMaxOutputTokens,
  type ProviderGroup,
  type TiamatCatalogRecord,
} from "./catalog.ts";
import { formatBudgetUsage, formatUsage, isProviders, providerId, type TiamatProviders } from "./usage.ts";

const LOG = "tiamat";
const logError = (value: unknown) => process.env.FAMILIAR_LOG_PATH
  ? errorLog(LOG, value)
  : console.error(`[tiamat] ${JSON.stringify(value)}`);
const logDebug = (value: unknown) => { if (process.env.FAMILIAR_LOG_PATH) debugLog(LOG, value); };
const CATALOG_PATH = "/tiamat/v1/models";
const PROVIDERS_PATH = "/tiamat/v1/providers";
const DEFAULT_POLL_SECONDS = 300;
const USAGE_POLL_MS = 5 * 60_000;
const USAGE_STALE_MS = 15 * 60_000;

class CatalogAuthError extends Error {}
interface CatalogResult { catalog: TiamatCatalogRecord[]; etag?: string }

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function pollSeconds(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_POLL_SECONDS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_POLL_SECONDS;
}

export default async function tiamat(pi: ExtensionAPI) {
  const configuredUrl = process.env.FAMILIAR_TIAMAT_URL;
  const tokenFile = process.env.FAMILIAR_TIAMAT_TOKEN_FILE;
  if (!configuredUrl || !tokenFile) {
    logError({ disabled: true, reason: "FAMILIAR_TIAMAT_URL and FAMILIAR_TIAMAT_TOKEN_FILE are required" });
    return;
  }

  const baseUrl = normalizeBaseUrl(configuredUrl);
  const catalogUrl = `${baseUrl}${CATALOG_PATH}`;
  const apiKey = `!cat -- ${shellQuote(tokenFile)}`; // resolved by pi for every inference request
  let appliedEtag: string | undefined;
  let registered = new Map<string, ProviderGroup>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let context: ExtensionContext | undefined;
  let failureLogged = false;
  let authStopped = false;
  let pollInFlight = false;
  let usageTimer: ReturnType<typeof setInterval> | undefined;
  let usageInFlight = false;
  let providers: TiamatProviders = {};
  let usageRefreshedAt = 0;
  let lastUsageStatus = "";

  const token = async () => (await readFile(tokenFile, "utf8")).trim();
  const request = async (method: "GET" | "HEAD", signal?: AbortSignal, etag?: string): Promise<Response> => {
    const bearer = await token();
    if (!bearer) throw new Error("Tiamat token file is empty");
    const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
    if (etag) headers["If-None-Match"] = etag;
    const response = await fetch(catalogUrl, { method, headers, signal });
    if (response.status === 401) throw new CatalogAuthError("Tiamat catalog returned 401; token may have rotated");
    return response;
  };
  const fetchCatalog = async (signal?: AbortSignal): Promise<CatalogResult> => {
    const response = await request("GET", signal);
    if (!response.ok) throw new Error(`Tiamat catalog returned HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!isCatalog(value)) throw new Error("Tiamat catalog response has an invalid shape");
    return { catalog: value, etag: response.headers.get("etag") ?? undefined };
  };
  const renderUsage = () => {
    if (!context?.hasUI) return;
    const id = providerId(context.model?.provider);
    const usage = id ? providers[id]?.usage : undefined;
    const stale = Date.now() - usageRefreshedAt > USAGE_STALE_MS;
    const status = id && usage
      ? (usage.windows?.length
        ? formatUsage(id, usage.windows, stale)
        : formatBudgetUsage(id, usage, stale))
      : undefined;
    const painted = status ? context.ui.theme.fg(status.tone, status.text) : "";
    if (painted === lastUsageStatus) return;
    lastUsageStatus = painted;
    context.ui.setStatus("tiamat", painted || undefined);
    // Publish for the footer extension (custom footer replaces the built-in
    // status line, so it re-renders provider usage itself from this event).
    pi.events.emit("familiar:provider-usage", {
      text: status?.text ?? "",
      tone: status?.tone ?? "dim",
    });
  };
  const pollUsage = async () => {
    if (!context?.hasUI || usageInFlight) return;
    usageInFlight = true;
    try {
      const bearer = await token();
      if (!bearer) return;
      const response = await fetch(`${baseUrl}${PROVIDERS_PATH}`, {
        headers: { Authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return;
      const value: unknown = await response.json();
      if (!isProviders(value)) return;
      providers = value;
      usageRefreshedAt = Date.now();
      renderUsage();
    } catch { /* Usage display must never affect an agent turn or spam logs. */ }
    finally { usageInFlight = false; }
  };
  const reportFailure = (error: unknown) => {
    if (error instanceof CatalogAuthError) authStopped = true;
    if (failureLogged) return;
    failureLogged = true;
    logError({ catalogError: String(error), pollingStoppedForAuth: authStopped });
  };
  const reportSuccess = () => { failureLogged = false; authStopped = false; };

  const reconcile = (result: CatalogResult) => {
    const next = catalogToProviderGroups(result.catalog, baseUrl);
    const nextIds = new Set(next.map((group) => group.id));
    const active = context?.model;
    if (active && registered.has(active.provider)) {
      const activeGroup = next.find((group) => group.id === active.provider);
      if (!activeGroup?.models.some((model) => model.id === active.id)) {
        logError({ activeModelRemoved: `${active.provider}/${active.id}` });
      }
    }
    for (const id of registered.keys()) if (!nextIds.has(id)) pi.unregisterProvider(id);
    const nextMap = new Map<string, ProviderGroup>();
    for (const group of next) {
      nextMap.set(group.id, group);
      pi.registerProvider(group.id, {
        name: group.name,
        baseUrl: group.baseUrl,
        apiKey,
        authHeader: true,
        api: group.api,
        models: group.models,
        async refreshModels({ signal }) {
          try {
            const fresh = await fetchCatalog(signal);
            reportSuccess();
            // A refresh callback must only refresh its own model list. Mutating the
            // registry here makes registerProvider trigger another refresh, creating
            // an unbounded refresh/re-register loop; it can also outlive the session
            // and use a stale extension context. ETag polling owns provider topology.
            return catalogToProviderGroups(fresh.catalog, baseUrl)
              .find((candidate) => candidate.id === group.id)?.models ?? [];
          } catch (error) {
            // Pi cancels startup refreshes during short-lived print sessions.
            // Preserve the registered snapshot without logging a false outage.
            if (signal.aborted) return group.models;
            reportFailure(error);
            throw error;
          }
        },
      });
    }
    registered = nextMap;
    appliedEtag = result.etag;
    logDebug({ catalogApplied: true, etag: appliedEtag, providers: next.length, models: next.reduce((n, g) => n + g.models.length, 0) });
  };

  // Missing/unreadable/empty token files are a permanent no-op for this load.
  try {
    if (!await token()) throw new Error("Tiamat token file is empty");
  } catch (error) {
    reportFailure(error);
    return;
  }
  try {
    const initial = await fetchCatalog(AbortSignal.timeout(10_000));
    reportSuccess();
    reconcile(initial);
  } catch (error) {
    reportFailure(error);
    // A transient startup outage can recover through session polling. A 401
    // intentionally stays stopped until the extension is reloaded.
    if (error instanceof CatalogAuthError) return;
  }

  const seconds = pollSeconds(process.env.FAMILIAR_TIAMAT_POLL_SECONDS);
  const schedule = () => {
    if (!seconds || timer) return;
    const jitter = 0.9 + Math.random() * 0.2;
    timer = setTimeout(() => {
      timer = undefined;
      void poll().finally(schedule);
    }, seconds * 1000 * jitter);
    timer.unref?.();
  };
  const poll = async () => {
    if (pollInFlight || authStopped) return;
    pollInFlight = true;
    try {
      const head = await request("HEAD", AbortSignal.timeout(10_000), appliedEtag);
      if (!head.ok && head.status !== 304) throw new Error(`Tiamat catalog HEAD returned HTTP ${head.status}`);
      const nextEtag = head.headers.get("etag");
      if (etagRequiresFetch(head.status, appliedEtag, nextEtag)) reconcile(await fetchCatalog(AbortSignal.timeout(10_000)));
      reportSuccess();
    } catch (error) {
      reportFailure(error);
    } finally {
      pollInFlight = false;
    }
  };

  // The router's Codex-backed Responses adapter requires Codex request
  // semantics but advertises the standard /v1/responses wire path. Pi's
  // standard Responses client always adds max_output_tokens, which this
  // adapter rejects. The payload hook has no model field, so scope via ctx.
  pi.on("before_provider_request", (event, ctx) => {
    if (!ctx.model?.provider.startsWith("tiamat-responses-")) return;
    return withoutMaxOutputTokens(event.payload);
  });

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    schedule();
    if (ctx.hasUI) {
      renderUsage();
      void pollUsage();
      usageTimer ??= setInterval(() => { void pollUsage(); renderUsage(); }, USAGE_POLL_MS);
      usageTimer.unref?.();
    }
  });
  pi.on("model_select", async (_event, ctx) => { context = ctx; renderUsage(); });
  pi.on("turn_end", async (_event, ctx) => { context = ctx; renderUsage(); });
  pi.on("session_shutdown", async () => {
    if (timer) clearTimeout(timer);
    if (usageTimer) clearInterval(usageTimer);
    timer = undefined;
    usageTimer = undefined;
    context = undefined;
  });
}
