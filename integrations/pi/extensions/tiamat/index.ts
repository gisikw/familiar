import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { errorLog, debugLog } from "../lib/debug.ts";
import {
  catalogToProviderGroups,
  etagRequiresFetch,
  isCatalog,
  normalizeBaseUrl,
  type ProviderGroup,
  type TiamatCatalogRecord,
} from "./catalog.ts";

const LOG = "tiamat";
const logError = (value: unknown) => process.env.FAMILIAR_LOG_PATH
  ? errorLog(LOG, value)
  : console.error(`[tiamat] ${JSON.stringify(value)}`);
const logDebug = (value: unknown) => { if (process.env.FAMILIAR_LOG_PATH) debugLog(LOG, value); };
const CATALOG_PATH = "/tiamat/v1/models";
const DEFAULT_POLL_SECONDS = 300;

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
            // Reconcile all provider permutations after this refresh callback returns.
            queueMicrotask(() => reconcile(fresh));
            return catalogToProviderGroups(fresh.catalog, baseUrl)
              .find((candidate) => candidate.id === group.id)?.models ?? [];
          } catch (error) {
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

  pi.on("session_start", async (_event, ctx) => { context = ctx; schedule(); });
  pi.on("session_shutdown", async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    context = undefined;
  });
}
