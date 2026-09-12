import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { errorLog, debugLog } from "../lib/debug.ts";
import {
  catalogToProviderGroups,
  etagRequiresFetch,
  isCatalog,
  normalizeBaseUrl,
  withoutMaxOutputTokens,
  type TiamatCatalogRecord,
} from "./catalog.ts";
import {
  formatBudgetUsage,
  formatUsage,
  isProviders,
  projectProviders,
  providerId,
  type TiamatPort,
  type TiamatProviders,
} from "./usage.ts";
import { restoredSelection, TiamatMaterializer } from "./materializer.ts";

const LOG = "tiamat";
const logError = (value: unknown) =>
  process.env.FAMILIAR_LOG_PATH
    ? errorLog(LOG, value)
    : console.error(`[tiamat] ${JSON.stringify(value)}`);
const logDebug = (value: unknown) => {
  if (process.env.FAMILIAR_LOG_PATH) debugLog(LOG, value);
};
const CATALOG_PATH = "/tiamat/v1/models";
const PROVIDERS_PATH = "/tiamat/v1/providers";
const DEFAULT_POLL_SECONDS = 300;
const USAGE_POLL_MS = 5 * 60_000;
const USAGE_STALE_MS = 15 * 60_000;

class CatalogAuthError extends Error {}
interface CatalogResult {
  catalog: TiamatCatalogRecord[];
  etag?: string;
}

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
    logError({
      disabled: true,
      reason: "FAMILIAR_TIAMAT_URL and FAMILIAR_TIAMAT_TOKEN_FILE are required",
    });
    return;
  }

  const baseUrl = normalizeBaseUrl(configuredUrl);
  const catalogUrl = `${baseUrl}${CATALOG_PATH}`;
  const apiKey = `!cat -- ${shellQuote(tokenFile)}`; // resolved by pi for every inference request
  let appliedEtag: string | undefined;
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
  let appliedCatalog: TiamatCatalogRecord[] = [];
  const materializer = new TiamatMaterializer(
    pi,
    baseUrl,
    apiKey,
    () => context,
  );

  // Pi awaits this narrow phase after extension factories and before CLI,
  // restored-session, or configured-default model resolution. Exact generated
  // routes materialize one row; bare/fuzzy CLI patterns intentionally do not
  // expand Tiamat's control-plane catalogue. List mode gets one deterministic
  // seed so JIT does not turn health checks into an empty catalogue.
  pi.registerModelBootstrap((request) => {
    if (request.source === "list") {
      materializer.bootstrap();
      return;
    }
    if (
      request.provider?.startsWith("tiamat-") &&
      request.modelId
    )
      materializer.bootstrap({
        provider: request.provider,
        modelId: request.modelId,
      });
  });

  // In-process projection for a UI bridge (familiar-ui). Read synchronously
  // while the bridge builds a snapshot; never carries the token or base URL.
  const port: TiamatPort = {
    providers: () => projectProviders(providers, appliedCatalog, baseUrl),
    activate: (provider, modelId) =>
      materializer.activate({ provider, modelId }),
    usageRefreshedAt: () => (usageRefreshedAt ? usageRefreshedAt : null),
  };
  const notifyChanged = () => {
    // A projection subscriber must never break catalog or usage handling.
    try {
      pi.events.emit("familiar:tiamat:changed", {});
    } catch {
      /* ignore */
    }
  };
  pi.events.on("familiar:tiamat:discover", (value: unknown) => {
    const accept = (value as { accept?: unknown } | null)?.accept;
    if (typeof accept === "function") accept(port);
  });

  const token = async () => (await readFile(tokenFile, "utf8")).trim();
  const request = async (
    method: "GET" | "HEAD",
    signal?: AbortSignal,
    etag?: string,
  ): Promise<Response> => {
    const bearer = await token();
    if (!bearer) throw new Error("Tiamat token file is empty");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearer}`,
    };
    if (etag) headers["If-None-Match"] = etag;
    const response = await fetch(catalogUrl, { method, headers, signal });
    if (response.status === 401)
      throw new CatalogAuthError(
        "Tiamat catalog returned 401; token may have rotated",
      );
    return response;
  };
  const fetchCatalog = async (signal?: AbortSignal): Promise<CatalogResult> => {
    const response = await request("GET", signal);
    if (!response.ok)
      throw new Error(`Tiamat catalog returned HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!isCatalog(value))
      throw new Error("Tiamat catalog response has an invalid shape");
    return { catalog: value, etag: response.headers.get("etag") ?? undefined };
  };
  const renderUsage = () => {
    if (!context?.hasUI) return;
    const id = providerId(context.model?.provider);
    const usage = id ? providers[id]?.usage : undefined;
    const stale = Date.now() - usageRefreshedAt > USAGE_STALE_MS;
    const status =
      id && usage
        ? usage.windows?.length
          ? formatUsage(id, usage.windows, stale)
          : formatBudgetUsage(id, usage, stale)
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
      notifyChanged();
    } catch {
      /* Usage display must never affect an agent turn or spam logs. */
    } finally {
      usageInFlight = false;
    }
  };
  const reportFailure = (error: unknown) => {
    if (error instanceof CatalogAuthError) authStopped = true;
    if (failureLogged) return;
    failureLogged = true;
    logError({
      catalogError: String(error),
      pollingStoppedForAuth: authStopped,
    });
  };
  const reportSuccess = () => {
    failureLogged = false;
    authStopped = false;
  };

  const reconcile = (result: CatalogResult) => {
    const next = catalogToProviderGroups(result.catalog, baseUrl);
    appliedEtag = result.etag;
    appliedCatalog = result.catalog;
    // Polling updates picker truth and only the definitions already in the
    // two-model execution set; it never pours the catalogue into Pi.
    materializer.updateCatalog(result.catalog);
    notifyChanged();
    logDebug({
      catalogApplied: true,
      etag: appliedEtag,
      providers: next.length,
      models: next.reduce((n, g) => n + g.models.length, 0),
      materialized: materializer.materialized().length,
    });
  };

  // Missing/unreadable/empty token files are a permanent no-op for this load.
  try {
    if (!(await token())) throw new Error("Tiamat token file is empty");
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
    timer = setTimeout(
      () => {
        timer = undefined;
        void poll().finally(schedule);
      },
      seconds * 1000 * jitter,
    );
    timer.unref?.();
  };
  const poll = async () => {
    if (pollInFlight || authStopped) return;
    pollInFlight = true;
    try {
      const head = await request(
        "HEAD",
        AbortSignal.timeout(10_000),
        appliedEtag,
      );
      if (!head.ok && head.status !== 304)
        throw new Error(`Tiamat catalog HEAD returned HTTP ${head.status}`);
      const nextEtag = head.headers.get("etag");
      if (etagRequiresFetch(head.status, appliedEtag, nextEtag))
        reconcile(await fetchCatalog(AbortSignal.timeout(10_000)));
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
    // Migration defense for old semantic entries or catalogues that were
    // transiently unavailable during bootstrap. Normal exact routes are already
    // materialized and selected before this lifecycle event.
    const restored = restoredSelection(ctx);
    if (
      restored &&
      (ctx.model?.provider !== restored.provider ||
        ctx.model.id !== restored.modelId)
    ) {
      const result = await materializer.activate(restored, false);
      if ("error" in result)
        logError({
          restoreModelFailed: result.error,
          provider: restored.provider,
          model: restored.modelId,
        });
    }
    schedule();
    if (ctx.hasUI) {
      renderUsage();
      void pollUsage();
      usageTimer ??= setInterval(() => {
        void pollUsage();
        renderUsage();
      }, USAGE_POLL_MS);
      usageTimer.unref?.();
    }
  });
  pi.on("model_select", async (_event, ctx) => {
    context = ctx;
    materializer.adopt(ctx.model);
    renderUsage();
  });
  pi.on("turn_end", async (_event, ctx) => {
    context = ctx;
    renderUsage();
  });
  pi.on("session_shutdown", async () => {
    if (timer) clearTimeout(timer);
    if (usageTimer) clearInterval(usageTimer);
    timer = undefined;
    usageTimer = undefined;
    context = undefined;
  });
}
