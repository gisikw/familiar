import { describe, expect, test } from "bun:test";
import { restoredSelection, TiamatMaterializer } from "./materializer.ts";
import type { TiamatCatalogRecord } from "./catalog.ts";

const record = (
  provider: string,
  model: string,
  api: TiamatCatalogRecord["api"] = "/anthropic/v1/messages",
  availability: TiamatCatalogRecord["availability"] = "available",
  context_window = 100_000,
): TiamatCatalogRecord => ({
  provider,
  model,
  api,
  availability,
  fidelity: "native",
  context_window,
});

class Host {
  providers = new Map<string, any>();
  models = new Map<string, any>();
  selected: any;
  accepted = true;
  failSet = false;
  setCalls = 0;
  setWait: Promise<void> | undefined;
  entries: unknown[] = [];
  registerProvider = (id: string, config: any) => {
    this.providers.set(id, config);
    for (const key of [...this.models.keys()])
      if (key.startsWith(`${id}/`)) this.models.delete(key);
    for (const model of config.models)
      this.models.set(`${id}/${model.id}`, { ...model, provider: id });
  };
  unregisterProvider = (id: string) => {
    this.providers.delete(id);
    for (const key of [...this.models.keys()])
      if (key.startsWith(`${id}/`)) this.models.delete(key);
  };
  async setModel(model: any) {
    this.setCalls++;
    if (this.setWait) await this.setWait;
    if (this.failSet) throw new Error("set failed");
    if (!this.accepted) return false;
    this.selected = model;
    context.model = model;
    return true;
  }
  appendEntry(_type: string, data?: unknown) {
    this.entries.push(data);
  }
}
const context: {
  model?: any;
  modelRegistry: { find: (p: string, m: string) => unknown };
  isIdle: () => boolean;
} = {
  model: undefined,
  modelRegistry: { find: () => undefined },
  isIdle: () => true,
};

function setup(catalog: TiamatCatalogRecord[]) {
  const host = new Host();
  context.model = undefined;
  context.isIdle = () => true;
  context.modelRegistry = { find: (p, m) => host.models.get(`${p}/${m}`) };
  const materializer = new TiamatMaterializer(
    host as any,
    "https://router",
    "!token",
    () => context,
  );
  materializer.updateCatalog(catalog);
  return { host, materializer };
}

const count = (host: Host) =>
  [...host.providers.values()].reduce(
    (n, provider) => n + provider.models.length,
    0,
  );

describe("Tiamat session restore", () => {
  test("prefers persisted semantic identity and migrates historical Pi routes", () => {
    const ctx = (entries: unknown[]) =>
      ({ sessionManager: { getBranch: () => entries } }) as any;
    expect(
      restoredSelection(
        ctx([
          {
            type: "model_change",
            provider: "tiamat-responses-codex%2Fpersonal",
            modelId: "gpt-5",
          },
        ]),
      ),
    ).toEqual({ provider: "codex/personal", modelId: "gpt-5" });
    expect(
      restoredSelection(
        ctx([
          {
            type: "model_change",
            provider: "tiamat-anthropic-old",
            modelId: "old",
          },
          {
            type: "custom",
            customType: "familiar.tiamat.selection.v1",
            data: { provider: "work", modelId: "sonnet" },
          },
        ]),
      ),
    ).toEqual({ provider: "work", modelId: "sonnet" });
  });
});

describe("Tiamat JIT materialization", () => {
  test("same-provider replacement stages current and keeps two MRU models", async () => {
    const { host, materializer } = setup([
      record("personal", "one"),
      record("personal", "two"),
      record("personal", "three"),
    ]);
    expect(
      await materializer.activate({ provider: "personal", modelId: "one" }),
    ).toEqual({ ok: true });
    expect(
      await materializer.activate({ provider: "personal", modelId: "two" }),
    ).toEqual({ ok: true });
    expect(
      [...host.providers.values()][0].models.map((m: any) => m.id),
    ).toEqual(["two", "one"]);
    expect(count(host)).toBe(2);
    await materializer.activate({ provider: "personal", modelId: "three" });
    expect(
      [...host.providers.values()][0].models.map((m: any) => m.id),
    ).toEqual(["three", "two"]);
    expect(count(host)).toBe(2);
  });

  test("cross-provider switch prunes only after selection and retains previous", async () => {
    const { host, materializer } = setup([
      record("a", "one"),
      record("b", "two", "/responses/v1/responses"),
      record("c", "three"),
    ]);
    await materializer.activate({ provider: "a", modelId: "one" });
    await materializer.activate({ provider: "b", modelId: "two" });
    expect([...host.providers.keys()].sort()).toEqual([
      "tiamat-anthropic-a",
      "tiamat-responses-b",
    ]);
    await materializer.activate({ provider: "c", modelId: "three" });
    expect([...host.providers.keys()].sort()).toEqual([
      "tiamat-anthropic-c",
      "tiamat-responses-b",
    ]);
    expect(count(host)).toBe(2);
  });

  test("auth and setModel failures roll back without removing current", async () => {
    const { host, materializer } = setup([
      record("a", "one"),
      record("b", "two"),
    ]);
    await materializer.activate({ provider: "a", modelId: "one" });
    const current = host.selected;
    host.accepted = false;
    expect(
      await materializer.activate({ provider: "b", modelId: "two" }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(context.model).toBe(current);
    expect(host.models.has("tiamat-anthropic-a/one")).toBe(true);
    expect(host.models.has("tiamat-anthropic-b/two")).toBe(false);
    host.accepted = true;
    host.failSet = true;
    expect(
      await materializer.activate({ provider: "b", modelId: "two" }),
    ).toEqual({ ok: false, error: "failed" });
    expect(host.models.has("tiamat-anthropic-a/one")).toBe(true);
  });

  test("rejects unavailable and unknown semantic selections without mutation", async () => {
    const { host, materializer } = setup([
      record("a", "gone", "/anthropic/v1/messages", "unavailable"),
    ]);
    expect(
      await materializer.activate({ provider: "a", modelId: "gone" }),
    ).toEqual({ ok: false, error: "unavailable" });
    expect(
      await materializer.activate({ provider: "a", modelId: "missing" }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(host.providers.size).toBe(0);
    expect(host.setCalls).toBe(0);
  });

  test("catalog refresh updates only materialized definitions and preserves removed active", async () => {
    const { host, materializer } = setup([
      record("a", "one", "/anthropic/v1/messages", "available", 100),
    ]);
    await materializer.activate({ provider: "a", modelId: "one" });
    materializer.updateCatalog([
      record("a", "one", "/anthropic/v1/messages", "degraded", 200),
      record("a", "other"),
    ]);
    expect(host.models.get("tiamat-anthropic-a/one").contextWindow).toBe(200);
    expect(host.models.has("tiamat-anthropic-a/other")).toBe(false);
    materializer.updateCatalog([]);
    expect(host.models.has("tiamat-anthropic-a/one")).toBe(true);
  });

  test("catalogue refresh serializes registry mutation behind an in-flight switch", async () => {
    const { host, materializer } = setup([
      record("a", "one"),
      record("b", "two", "/anthropic/v1/messages", "available", 100),
    ]);
    await materializer.activate({ provider: "a", modelId: "one" });
    let release!: () => void;
    host.setWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const switching = materializer.activate({ provider: "b", modelId: "two" });
    await Promise.resolve();
    await Promise.resolve();
    materializer.updateCatalog([
      record("a", "one"),
      record("b", "two", "/anthropic/v1/messages", "available", 200),
    ]);
    expect(host.models.has("tiamat-anthropic-b/two")).toBe(true);
    release();
    expect(await switching).toEqual({ ok: true });
    await Promise.resolve();
    expect(host.models.get("tiamat-anthropic-b/two").contextWindow).toBe(200);
  });

  test("activation is idle-only, serialized, and duplicate requests are idempotent", async () => {
    const { host, materializer } = setup([
      record("a", "one"),
      record("b", "two"),
    ]);
    context.isIdle = () => false;
    expect(
      await materializer.activate({ provider: "a", modelId: "one" }),
    ).toEqual({ ok: false, error: "busy" });
    context.isIdle = () => true;
    const first = materializer.activate({ provider: "a", modelId: "one" });
    const duplicate = materializer.activate({ provider: "a", modelId: "one" });
    expect(first).toBe(duplicate);
    await Promise.all([first, duplicate]);
    expect(host.setCalls).toBe(1);
    await Promise.all([
      materializer.activate({ provider: "b", modelId: "two" }),
      materializer.activate({ provider: "a", modelId: "one" }),
    ]);
    expect(host.setCalls).toBe(3);
    expect(count(host)).toBeLessThanOrEqual(2);
  });
});
