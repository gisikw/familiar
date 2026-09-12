import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
  catalogToProviderGroups,
  routeForRecord,
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
/** Exact generated Pi route plus its wire model id. */
export interface SemanticModel {
  provider: string;
  modelId: string;
}

type PiModel = Parameters<ExtensionAPI["setModel"]>[0];
interface MaterializerHost {
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider(name: string): void;
  setModel(model: PiModel): Promise<boolean>;
  appendEntry<T>(customType: string, data?: T): void;
}
interface MaterializerContext {
  model?: PiModel;
  modelRegistry: {
    find(provider: string, modelId: string): PiModel | undefined;
  };
  isIdle(): boolean;
}

const SELECTION_ENTRY = "familiar.tiamat.selection.v1";
const ROUTE = /^tiamat-(?:anthropic|openai|responses)-(.+)$/;
const keyOf = (selection: SemanticModel) =>
  `${selection.provider}\0${selection.modelId}`;
const sameModel = (
  left: { provider: string; id: string } | undefined,
  right: { provider: string; id: string } | undefined,
) =>
  !!left &&
  !!right &&
  left.provider === right.provider &&
  left.id === right.id;

/**
 * Owns Tiamat's tiny Pi execution working set. The catalogue stays outside Pi;
 * only the current and previous exact route selections are registered.
 */
export class TiamatMaterializer {
  private catalog: readonly TiamatCatalogRecord[] = [];
  private mru: SemanticModel[] = [];
  private definitions = new Map<string, ProviderGroup>();
  private operation: Promise<ActivationResult> | undefined;
  private operationKey: string | undefined;
  private activating = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: MaterializerHost,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly context: () => MaterializerContext | undefined,
  ) {}

  updateCatalog(catalog: readonly TiamatCatalogRecord[]): void {
    this.catalog = catalog;
    const reconcile = () => {
      if (this.mru.length) this.apply(this.mru, this.context()?.model);
    };
    // Registry mutations serialize behind selection. `reconcile` reads the
    // latest catalogue when it runs, so an older poll cannot reapply stale data.
    if (this.operation) void this.tail.then(reconcile);
    else reconcile();
  }

  /** Materialize an exact generated route without selecting or persisting it. */
  bootstrap(selection?: SemanticModel): void {
    const requested = selection ?? this.firstAvailable();
    if (!requested) return;
    let target = this.resolve(requested);
    // Match Pi's CLI shorthand without guessing: the full id wins, and only a
    // recognized thinking-level suffix may be removed on an exact provider.
    if (!target) {
      const colon = requested.modelId.lastIndexOf(":");
      const suffix = colon < 0 ? "" : requested.modelId.slice(colon + 1);
      if (
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          suffix,
        )
      )
        target = this.resolve({
          ...requested,
          modelId: requested.modelId.slice(0, colon),
        });
    }
    if (!target)
      throw new Error(
        `Tiamat model route not found: ${requested.provider}/${requested.modelId}`,
      );
    const canonical = target.selection;
    const staged = [canonical, ...this.mru]
      .filter(
        (item, index, all) =>
          all.findIndex((other) => keyOf(other) === keyOf(item)) === index,
      )
      .slice(0, 2);
    this.apply(staged, this.context()?.model);
    this.mru = staged;
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

  /** Track a selection made by Pi's TUI/RPC among the bounded registrations. */
  adopt(model: PiModel | undefined): void {
    // `setModel` during an activation emits `model_select` before that
    // activation has staged its own MRU; adopting there would interleave a
    // second registry mutation into an atomic swap that already accounts for
    // this exact selection.
    if (this.activating) return;
    const selection = this.selectionForPi(model);
    if (!selection) return;
    this.mru = [selection, ...this.mru]
      .filter(
        (item, index, all) =>
          all.findIndex((other) => keyOf(other) === keyOf(item)) === index,
      )
      .slice(0, 2);
    this.apply(this.mru, model);
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

  private firstAvailable(): SemanticModel | undefined {
    const group = this.groups()[0];
    const model = group?.models[0];
    return group && model
      ? { provider: group.id, modelId: model.id }
      : undefined;
  }

  private resolve(selection: SemanticModel):
    | {
        selection: SemanticModel;
        group: ProviderGroup;
        model: ProviderGroup["models"][number];
      }
    | undefined {
    const groups = this.groups();
    if (ROUTE.test(selection.provider)) {
      const group = groups.find((candidate) => candidate.id === selection.provider);
      const model = group?.models.find(
        (candidate) => candidate.id === selection.modelId,
      );
      return group && model
        ? { selection, group, model }
        : undefined;
    }
    // Migration only: old semantic entries carried account/model without wire
    // family. Accept them iff the catalogue maps that pair to one exact route.
    const matches = groups.flatMap((group) =>
      group.tiamatProvider === selection.provider
        ? group.models
            .filter((model) => model.id === selection.modelId)
            .map((model) => ({
              selection: { provider: group.id, modelId: model.id },
              group,
              model,
            }))
        : [],
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  private selectionForPi(model: PiModel | undefined): SemanticModel | undefined {
    if (!model || !ROUTE.test(model.provider)) return undefined;
    if (
      this.groups().some(
        (group) =>
          group.id === model.provider &&
          group.models.some((candidate) => candidate.id === model.id),
      ) ||
      [...this.definitions.values()].some(
        (definition) =>
          definition.id === model.provider &&
          definition.models.some((candidate) => candidate.id === model.id),
      )
    )
      return { provider: model.provider, modelId: model.id };
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
    for (const selection of selections.slice(0, 2)) {
      const resolved = this.resolve(selection);
      if (resolved)
        nextDefinitions.set(keyOf(resolved.selection), {
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
            (model) =>
              !existing.models.some((candidate) => candidate.id === model.id),
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
    const target = this.resolve(selection);
    if (!target) {
      const knownUnavailable = this.catalog.some((record) => {
        const route = routeForRecord(record);
        return (
          (selection.provider === route || selection.provider === record.provider) &&
          selection.modelId === record.model &&
          record.availability === "unavailable"
        );
      });
      return { ok: false, error: knownUnavailable ? "unavailable" : "not_found" };
    }

    const oldMru = [...this.mru];
    const oldModel = ctx.model;
    const current = this.selectionForPi(oldModel);
    const staged = [target.selection, ...(current ? [current] : oldMru)]
      .filter(
        (item, index, all) =>
          all.findIndex((other) => keyOf(other) === keyOf(item)) === index,
      )
      .slice(0, 2);
    let refused = false;
    this.activating = true;
    try {
      this.apply(staged, oldModel);
      const model = ctx.modelRegistry.find(
        target.group.id,
        target.selection.modelId,
      );
      if (!model)
        throw new Error("registered Tiamat model was not found in Pi");
      if (!ctx.isIdle())
        throw new Error("session became busy during model activation");
      const ok = await this.host.setModel(model);
      if (!ok) {
        refused = true;
        throw new Error("Tiamat model authentication was refused");
      }
      this.mru = staged;
      this.apply(this.mru, model);
      if (persist) this.host.appendEntry(SELECTION_ENTRY, target.selection);
      return { ok: true };
    } catch {
      // A host may throw after changing its model. Restore the old model when
      // possible; if rollback itself fails, retain the actual current route and
      // its predecessor rather than pruning the now-live registration.
      if (oldModel && !sameModel(ctx.model, oldModel)) {
        const registeredOld = ctx.modelRegistry.find(
          oldModel.provider,
          oldModel.id,
        );
        if (registeredOld) {
          try {
            await this.host.setModel(registeredOld);
          } catch {
            /* retain actual state below */
          }
        }
      }
      const actual = this.selectionForPi(ctx.model);
      this.mru = actual
        ? [actual, ...oldMru]
            .filter(
              (item, index, all) =>
                all.findIndex((other) => keyOf(other) === keyOf(item)) === index,
            )
            .slice(0, 2)
        : oldMru.length
          ? oldMru
          : current
            ? [current]
            : [];
      this.apply(this.mru, ctx.model);
      return {
        ok: false,
        error: ctx.isIdle() ? (refused ? "forbidden" : "failed") : "busy",
      };
    } finally {
      this.activating = false;
    }
  }
}

/** Latest exact route selection, with migration from old semantic entries. */
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
    if (
      typeof provider === "string" &&
      typeof modelId === "string" &&
      ROUTE.test(provider)
    )
      return { provider, modelId };
  }
  return undefined;
}
