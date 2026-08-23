export type TiamatAvailability = "available" | "degraded" | "unavailable";

export interface TiamatCatalogRecord {
  model: string;
  api: "/anthropic/v1/messages" | "/openai/v1/chat/completions" | "/responses/v1/responses";
  provider: string;
  fidelity: string;
  availability: TiamatAvailability;
  reason?: string;
  resetsIn?: string;
}

export interface PiModelDefinition {
  id: string;
  name: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface ProviderGroup {
  id: string;
  name: string;
  api: "anthropic-messages" | "openai-completions" | "openai-responses";
  baseUrl: string;
  family: "anthropic" | "openai" | "responses";
  tiamatProvider: string;
  models: PiModelDefinition[];
}

const WIRES = {
  // Pi's Anthropic SDK appends /v1/messages, while its OpenAI SDK appends
  // /chat/completions or /responses. Include /v1 in only the latter bases so
  // all three resolve to Tiamat's wire-native paths.
  "/anthropic/v1/messages": { api: "anthropic-messages", family: "anthropic", baseSuffix: "" },
  "/openai/v1/chat/completions": { api: "openai-completions", family: "openai", baseSuffix: "/v1" },
  "/responses/v1/responses": { api: "openai-responses", family: "responses", baseSuffix: "/v1" },
} as const;

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function isCatalog(value: unknown): value is TiamatCatalogRecord[] {
  if (!Array.isArray(value)) return false;
  return value.every((record) => {
    if (!record || typeof record !== "object") return false;
    const item = record as Record<string, unknown>;
    return typeof item.model === "string" && typeof item.provider === "string" &&
      typeof item.fidelity === "string" && item.api in WIRES &&
      ["available", "degraded", "unavailable"].includes(String(item.availability));
  });
}

/**
 * Pi sends Model.id as the request body's wire model. Consequently each Tiamat
 * account gets a distinct pi provider and model ids remain the upstream ids.
 */
export function catalogToProviderGroups(catalog: TiamatCatalogRecord[], rawBaseUrl: string): ProviderGroup[] {
  const base = normalizeBaseUrl(rawBaseUrl);
  const groups = new Map<string, ProviderGroup>();
  for (const record of catalog) {
    if (record.availability === "unavailable") continue;
    const wire = WIRES[record.api];
    const id = `tiamat-${wire.family}-${encodeURIComponent(record.provider)}`;
    let group = groups.get(id);
    if (!group) {
      const scopedBase = `${base}/${wire.family}/${encodeURIComponent(record.provider)}${wire.baseSuffix}`;
      group = {
        id,
        name: `Tiamat ${wire.family} (${record.provider})`,
        api: wire.api,
        baseUrl: scopedBase,
        family: wire.family,
        tiamatProvider: record.provider,
        models: [],
      };
      groups.set(id, group);
    }
    group.models.push({
      id: record.model,
      name: `${record.model} via ${record.provider}${record.availability === "degraded" ? " (degraded)" : ""}`,
      baseUrl: group.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    });
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)).map((group) => ({
    ...group,
    models: group.models.sort((a, b) => a.id.localeCompare(b.id)),
  }));
}

/** A 304 is unchanged; a 200 without an ETag is fetched conservatively. */
export function etagRequiresFetch(status: number, previousEtag: string | undefined, nextEtag: string | null): boolean {
  if (status === 304) return false;
  if (status !== 200) return false;
  return !nextEtag || !previousEtag || nextEtag !== previousEtag;
}

/** Tiamat's Codex-backed Responses route rejects this standard Responses field. */
export function withoutMaxOutputTokens(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || !("max_output_tokens" in payload)) return payload;
  const { max_output_tokens: _unsupported, ...rest } = payload as Record<string, unknown>;
  return rest;
}
