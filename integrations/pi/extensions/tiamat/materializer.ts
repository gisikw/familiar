import type {
  ExtensionContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
  catalogToProviderGroups,
  type ProviderGroup,
  type TiamatCatalogRecord,
} from "./catalog.ts";

export type ActivationError =
  | "busy"
  | "not_found"
  | "unavailable"
  | "forbidden"
  | "failed";
export type ActivationResult =
  | { ok: true }
  | { ok: false; error: ActivationError };
export interface SemanticModel {
  provider: string;
  modelId: string;
}

interface MaterializerHost {
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider(name: string): void;
  setModel(model: any): Promise<boolean>;
  appendEntry<T>(customType: string, data?: T): void;
}
interface MaterializerContext {
  model?: { provider: string; id: string };
  modelRegistry: { find(provider: string, modelId: string): any };
  isIdle(): boolean;
}

const SELECTION_ENTRY = "familiar.tiamat.selection.v1";
const keyOf = (selection: SemanticModel) =>
  `${selection.provider}\0${selection.modelId}`;

/**
 * Owns Tiamat's tiny Pi execution working set. The catalogue stays outside Pi;
 * only the current and previous semantic selections are registered.
 */
export class TiamatMaterializer {
  private catalog: readonly TiamatCatalogRecord[] = [];
  private mru: SemanticModel[] = [];
  private definitions = new Map<string, ProviderGroup>();
  private operation: Promise<ActivationResult> | undefined;
  private operationKey: string | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: MaterializerHost,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly context: () => MaterializerContext | undefined,
  ) {}

  updateCatalog(catalog: readonly TiamatCatalogRecord[]): void {
    this.catalog = catalog;
    // Polling refreshes exact definitions only for materialized rows. A removed
    // active row retains its last usable definition, but is absent/disabled in
    // catalogue truth and cannot be newly activated.
    const reconcile = () => {
      if (this.mru.length) this.apply(this.mru, this.context()?.model);
    };
    // A poll may finish while setModel is awaiting authentication. Catalogue
    // truth changes immediately, but registry mutation waits behind activation.
    if (this.operation) void this.tail.then(reconcile);
    else reconcile();
  }

  activate(
    selection: SemanticModel,
    persist = true,
  ): Promise<ActivationResult> {
    const key = keyOf(selection);
    if (this.operation && this.operationKey === key) return this.operation;
    const run = this.tail.then(() => this.activateAtomic(selection, persist));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.operation = run;
    this.operationKey = key;
    void run.finally(() => {
      if (this.operation === run) {
        this.operation = undefined;
        this.operationKey = undefined;
      }
    });
    return run;
  }

  materialized(): readonly SemanticModel[] {
    return this.mru;
  }

  private groups(): ProviderGroup[] {
    return catalogToProviderGroups(
      this.catalog as TiamatCatalogRecord[],
      this.baseUrl,
    );
  }

  private resolve(
    selection: SemanticModel,
  ):
    | { group: ProviderGroup; model: ProviderGroup["models"][number] }
    | undefined {
    for (const group of this.groups()) {
      if (group.tiamatProvider !== selection.provider) continue;
      const model = group.models.find(
        (candidate) => candidate.id === selection.modelId,
      );
      if (model) return { group, model };
    }
    return undefined;
  }

  private semanticForPi(
    model: { provider: string; id: string } | undefined,
  ): SemanticModel | undefined {
    if (!model) return undefined;
    const group = this.groups().find(
      (candidate) => candidate.id === model.provider,
    );
    if (group?.models.some((candidate) => candidate.id === model.id))
      return { provider: group.tiamatProvider, modelId: model.id };
    for (const [key, definition] of this.definitions) {
      if (
        definition.id === model.provider &&
        definition.models.some((candidate) => candidate.id === model.id)
      ) {
        const [provider, modelId] = key.split("\0");
        if (provider && modelId === model.id) return { provider, modelId };
      }
    }
    return undefined;
  }

  private config(group: ProviderGroup, models = group.models): ProviderConfig {
    return {
      name: group.name,
      baseUrl: group.baseUrl,
      apiKey: this.apiKey,
      authHeader: true,
      api: group.api,
      models,
    };
  }

  private apply(
    selections: readonly SemanticModel[],
    active?: { provider: string; id: string },
  ): void {
    const nextDefinitions = new Map<string, ProviderGroup>();
    for (const selection of selections) {
      const resolved = this.resolve(selection);
      if (resolved)
        nextDefinitions.set(keyOf(selection), {
          ...resolved.group,
          models: [resolved.model],
        });
      else {
        const retained = this.definitions.get(keyOf(selection));
        // Never destroy the live model merely because catalogue truth removed it.
        if (
          retained &&
          active?.provider === retained.id &&
          active.id === selection.modelId
        )
          nextDefinitions.set(keyOf(selection), retained);
      }
    }
    const byProvider = new Map<string, ProviderGroup>();
    for (const definition of nextDefinitions.values()) {
      const existing = byProvider.get(definition.id);
      if (existing)
        existing.models.push(
          ...definition.models.filter(
            (m) => !existing.models.some((e) => e.id === m.id),
          ),
        );
      else
        byProvider.set(definition.id, {
          ...definition,
          models: [...definition.models],
        });
    }
    const oldProviders = new Set(
      [...this.definitions.values()].map((definition) => definition.id),
    );
    for (const group of byProvider.values()) {
      this.host.registerProvider(group.id, this.config(group));
      oldProviders.delete(group.id);
    }
    for (const provider of oldProviders) {
      if (active?.provider !== provider) this.host.unregisterProvider(provider);
    }
    this.definitions = nextDefinitions;
  }

  private async activateAtomic(
    selection: SemanticModel,
    persist: boolean,
  ): Promise<ActivationResult> {
    const ctx = this.context();
    if (!ctx?.isIdle()) return { ok: false, error: "busy" };
    const record = this.catalog.find(
      (candidate) =>
        candidate.provider === selection.provider &&
        candidate.model === selection.modelId,
    );
    if (!record) return { ok: false, error: "not_found" };
    if (record.availability === "unavailable")
      return { ok: false, error: "unavailable" };
    const target = this.resolve(selection);
    if (!target) return { ok: false, error: "not_found" };

    const oldMru = [...this.mru];
    const current = this.semanticForPi(ctx.model);
    const staged = [selection, ...(current ? [current] : oldMru)]
      .filter(
        (item, index, all) =>
          all.findIndex((other) => keyOf(other) === keyOf(item)) === index,
      )
      .slice(0, 2);
    try {
      // Stage target + current first. In the same-provider case this replacement
      // includes both models, so registering the target cannot remove current.
      this.apply(staged, ctx.model);
      const model = ctx.modelRegistry.find(target.group.id, selection.modelId);
      if (!model)
        throw new Error("registered Tiamat model was not found in Pi");
      if (!ctx.isIdle())
        throw new Error("session became busy during model activation");
      const ok = await this.host.setModel(model);
      if (!ok) {
        this.apply(
          oldMru.length ? oldMru : current ? [current] : [],
          ctx.model,
        );
        return { ok: false, error: "forbidden" };
      }
      this.mru = staged;
      // setModel succeeded: only now may providers/models outside the two MRU go.
      this.apply(
        this.mru,
        target.model
          ? { provider: target.group.id, id: target.model.id }
          : ctx.model,
      );
      if (persist) this.host.appendEntry(SELECTION_ENTRY, selection);
      return { ok: true };
    } catch {
      this.apply(oldMru.length ? oldMru : current ? [current] : [], ctx.model);
      return { ok: false, error: ctx.isIdle() ? "failed" : "busy" };
    }
  }
}

/** Latest semantic selection, with migration from Pi's generated route identity. */
export function restoredSelection(
  ctx: ExtensionContext,
): SemanticModel | undefined {
  const branch = ctx.sessionManager.getBranch() as unknown as Array<
    Record<string, unknown>
  >;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (
      (entry.type === "custom" || entry.type === "custom_message") &&
      entry.customType === SELECTION_ENTRY
    ) {
      const data = entry.data as Record<string, unknown> | undefined;
      if (
        typeof data?.provider === "string" &&
        typeof data.modelId === "string"
      )
        return { provider: data.provider, modelId: data.modelId };
    }
    const provider =
      entry.type === "model_change"
        ? entry.provider
        : entry.type === "message" &&
            (entry.message as Record<string, unknown> | undefined)?.role ===
              "assistant"
          ? (entry.message as Record<string, unknown>).provider
          : undefined;
    const modelId =
      entry.type === "model_change"
        ? entry.modelId
        : entry.type === "message"
          ? (entry.message as Record<string, unknown> | undefined)?.model
          : undefined;
    if (typeof provider === "string" && typeof modelId === "string") {
      const match = /^tiamat-(?:anthropic|openai|responses)-(.+)$/.exec(
        provider,
      );
      if (match) {
        try {
          return { provider: decodeURIComponent(match[1]!), modelId };
        } catch {
          return { provider: match[1]!, modelId };
        }
      }
    }
  }
  return undefined;
}
