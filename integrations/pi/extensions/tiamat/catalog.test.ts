import { describe, expect, test } from "bun:test";
import { catalogToProviderGroups, etagRequiresFetch, type TiamatCatalogRecord } from "./catalog.ts";

const records: TiamatCatalogRecord[] = [
  { model: "claude-sonnet", api: "/anthropic/v1/messages", provider: "personal", fidelity: "native", availability: "available" },
  { model: "claude-sonnet", api: "/anthropic/v1/messages", provider: "work", fidelity: "native", availability: "degraded" },
  { model: "gpt-next", api: "/responses/v1/responses", provider: "codex/personal", fidelity: "native", availability: "available" },
  { model: "gone", api: "/openai/v1/chat/completions", provider: "metered", fidelity: "native", availability: "unavailable" },
];

describe("Tiamat catalog mapping", () => {
  test("keeps wire model ids clean by splitting duplicate models into account providers", () => {
    const groups = catalogToProviderGroups(records, "https://router.example/");
    expect(groups.map((group) => group.id)).toEqual([
      "tiamat-anthropic-personal",
      "tiamat-anthropic-work",
      "tiamat-responses-codex%2Fpersonal",
    ]);
    expect(groups[0].models[0].id).toBe("claude-sonnet");
    expect(groups[0].models[0].baseUrl).toBe("https://router.example/anthropic/personal");
    expect(groups[2].baseUrl).toBe("https://router.example/responses/codex%2Fpersonal");
  });

  test("filters unavailable and labels degraded records", () => {
    const groups = catalogToProviderGroups(records, "https://router.example");
    expect(groups.flatMap((group) => group.models).some((model) => model.id === "gone")).toBe(false);
    expect(groups.find((group) => group.id === "tiamat-anthropic-work")?.models[0].name)
      .toBe("claude-sonnet via work (degraded)");
  });
});

describe("ETag polling", () => {
  test("fetches only when a successful HEAD indicates possible change", () => {
    expect(etagRequiresFetch(304, '"old"', '"old"')).toBe(false);
    expect(etagRequiresFetch(200, '"old"', '"old"')).toBe(false);
    expect(etagRequiresFetch(200, '"old"', '"new"')).toBe(true);
    expect(etagRequiresFetch(200, undefined, '"new"')).toBe(true);
    expect(etagRequiresFetch(200, '"old"', null)).toBe(true);
    expect(etagRequiresFetch(500, '"old"', '"new"')).toBe(false);
  });
});
