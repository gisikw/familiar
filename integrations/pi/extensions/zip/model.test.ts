import { describe, expect, test } from "bun:test";
import { resolveSummarizerModel, summarizerCandidates } from "./model.ts";

type Fake = { provider: string; id: string };

const registryOf = (models: Fake[], authed: string[]) => ({
  getAll: () => models,
  find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
  hasConfiguredAuth: (model: Fake) => authed.includes(`${model.provider}/${model.id}`),
});

// The live shape that broke production: no bare `anthropic` provider at all.
const router = "tiamat-anthropic-claude-code-personal";
const live: Fake[] = [
  { provider: router, id: "claude-fable-5-1" },
  { provider: router, id: "claude-sonnet-4-6" },
  { provider: router, id: "claude-haiku-4-5-20251001" },
];
const current = { provider: router, id: "claude-fable-5-1" };

describe("zip summarizer model resolution", () => {
  test("prefers a small sibling on the session's current provider", () => {
    const registry = registryOf(live, live.map((model) => `${model.provider}/${model.id}`));
    const resolved = resolveSummarizerModel(registry, current);
    expect(resolved).toMatchObject({ ref: `${router}/claude-haiku-4-5-20251001` });
  });

  test("honors FAMILIAR_ZIP_MODEL above everything else", () => {
    const models = [...live, { provider: "google", id: "gemini-flash" }];
    const registry = registryOf(models, [`${router}/claude-haiku-4-5-20251001`, "google/gemini-flash"]);
    const resolved = resolveSummarizerModel(registry, current, "google/gemini-flash");
    expect(resolved).toMatchObject({ ref: "google/gemini-flash" });
  });

  test("falls past an override that exists but has no auth", () => {
    const registry = registryOf(
      [...live, { provider: "google", id: "gemini-flash" }],
      [`${router}/claude-haiku-4-5-20251001`],
    );
    const resolved = resolveSummarizerModel(registry, current, "google/gemini-flash");
    expect(resolved).toMatchObject({ ref: `${router}/claude-haiku-4-5-20251001` });
  });

  test("falls back to the current model when the provider has no cheap sibling", () => {
    const models = [{ provider: router, id: "claude-fable-5-1" }];
    const registry = registryOf(models, [`${router}/claude-fable-5-1`]);
    const resolved = resolveSummarizerModel(registry, current);
    expect(resolved).toMatchObject({ ref: `${router}/claude-fable-5-1` });
  });

  test("still reaches the legacy anthropic default when that is the authed one", () => {
    const models = [...live, { provider: "anthropic", id: "claude-haiku-4-5" }];
    const registry = registryOf(models, ["anthropic/claude-haiku-4-5"]);
    const resolved = resolveSummarizerModel(registry, current);
    expect(resolved).toMatchObject({ ref: "anthropic/claude-haiku-4-5" });
  });

  test("never picks an unauthenticated model and reports what it tried", () => {
    const registry = registryOf(live, []);
    const resolved = resolveSummarizerModel(registry, current) as { error: string; tried: string[] };
    expect(resolved.error).toContain("no summarizer model with configured auth");
    expect(resolved.tried).toContain(`${router}/claude-haiku-4-5-20251001`);
    expect(resolved.tried).toContain("anthropic/claude-haiku-4-5");
  });

  test("orders hints haiku, flash, mini, small and dedupes", () => {
    const models: Fake[] = [
      { provider: router, id: "small-thing" },
      { provider: router, id: "mini-thing" },
      { provider: router, id: "flash-thing" },
      { provider: router, id: "claude-haiku-4-5" },
      { provider: "other", id: "haiku-elsewhere" },
    ];
    const candidates = summarizerCandidates(registryOf(models, []), current, `${router}/claude-haiku-4-5`);
    expect(candidates.map((ref) => `${ref.provider}/${ref.id}`)).toEqual([
      `${router}/claude-haiku-4-5`,
      `${router}/flash-thing`,
      `${router}/mini-thing`,
      `${router}/small-thing`,
      `${router}/claude-fable-5-1`,
      "anthropic/claude-haiku-4-5",
    ]);
  });

  test("survives a session with no current model", () => {
    const registry = registryOf([{ provider: "anthropic", id: "claude-haiku-4-5" }], ["anthropic/claude-haiku-4-5"]);
    expect(resolveSummarizerModel(registry, undefined)).toMatchObject({ ref: "anthropic/claude-haiku-4-5" });
  });
});
