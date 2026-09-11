import { describe, expect, test } from "bun:test";
import { projectProviders } from "./usage.ts";
import type { TiamatCatalogRecord } from "./catalog.ts";

const catalog: TiamatCatalogRecord[] = [
  { model: "claude-sonnet", api: "/anthropic/v1/messages", provider: "claude-code-personal", fidelity: "native", availability: "available" },
  { model: "claude-opus", api: "/anthropic/v1/messages", provider: "claude-code-personal", fidelity: "native", availability: "degraded", reason: "upstream" },
  { model: "gpt-next", api: "/responses/v1/responses", provider: "codex/personal", fidelity: "native", availability: "available" },
  { model: "o-pro", api: "/responses/v1/responses", provider: "codex/personal", fidelity: "native", availability: "unavailable", reason: "quota", resetsIn: "25m" },
  { model: "qwen-30b", api: "/openai/v1/chat/completions", provider: "frankenstein", fidelity: "native", availability: "unavailable", reason: "upstream" },
];

const providers = {
  "claude-code-personal": {
    kind: "oauth-client", locality: "remote",
    usage: {
      fetchedAt: "2026-09-11T10:00:00.000Z",
      windows: [
        { name: "five-hour", used: "7%", resetsIn: "25m", resetsInSeconds: 1500 },
        { name: "weekly", used: "20%", resetsIn: "4d2h", resetsInSeconds: 352_800 },
      ],
    },
  },
  "codex/personal": {
    kind: "oauth-client", locality: "remote",
    usage: { windows: [{ name: "weekly", used: "41%", resetsIn: "3d", resetsInSeconds: 259_200 }], credits: { balance: "4.20", hasCredits: true }, planType: "plus" },
  },
  "openrouter-personal": {
    kind: "api-key", locality: "remote",
    usage: { spend: { period: "month", amount: "12.47", currency: "USD" }, fetchedAt: "2026-09-11T10:01:00.000Z" },
  },
  frankenstein: { kind: "api-key", locality: "local", usage: {} },
} as any;

describe("Tiamat UI port projection", () => {
  test("groups by registered provider and keeps only router-published fields", () => {
    const out = projectProviders(providers, catalog, "https://router.example/");
    expect(out.map((p) => p.id)).toEqual(["claude-code-personal", "codex/personal", "frankenstein", "openrouter-personal"]);
    const claude = out[0]!;
    expect(claude.kind).toBe("oauth-client");
    expect(claude.locality).toBe("remote");
    expect(claude.members).toEqual(["tiamat-anthropic-claude-code-personal"]);
    expect(claude.models).toEqual([
      { id: "claude-sonnet", availability: "available" },
      { id: "claude-opus", availability: "degraded", reason: "upstream" },
    ]);
    expect(claude.usage).toEqual({
      windows: [
        { name: "five-hour", used: 7, usedText: "7%", resetsIn: "25m", resetsInSeconds: 1500 },
        { name: "weekly", used: 20, usedText: "20%", resetsIn: "4d2h", resetsInSeconds: 352_800 },
      ],
      fetchedAt: Date.parse("2026-09-11T10:00:00.000Z"),
    });
    expect(JSON.stringify(out)).not.toContain("router.example");
    expect(JSON.stringify(out)).not.toContain("planType");
  });

  test("unavailable models are kept with the router's reason while Pi registers nothing for them", () => {
    const out = projectProviders(providers, catalog, "https://router.example");
    const codex = out.find((p) => p.id === "codex/personal")!;
    expect(codex.members).toEqual(["tiamat-responses-codex%2Fpersonal"]);
    expect(codex.models).toEqual([
      { id: "gpt-next", availability: "available" },
      { id: "o-pro", availability: "unavailable", reason: "quota", resetsIn: "25m" },
    ]);
    expect(codex.usage?.credits).toEqual({ balance: "4.20" });
    const local = out.find((p) => p.id === "frankenstein")!;
    expect(local.members).toEqual([]);
    expect(local.locality).toBe("local");
    expect(local.usage).toBeNull();
  });

  test("metered spend is a figure with no denominator, and a provider with no catalogue still appears", () => {
    const out = projectProviders(providers, catalog, "https://router.example");
    const or = out.find((p) => p.id === "openrouter-personal")!;
    expect(or.usage).toEqual({ windows: [], spend: { period: "month", amount: "12.47", currency: "USD" }, fetchedAt: Date.parse("2026-09-11T10:01:00.000Z") });
    expect(or.models).toEqual([]);
  });

  test("tolerates a missing usage body and unparsable percentages", () => {
    const out = projectProviders({ odd: { usage: { windows: [{ name: "w", used: "lots", resetsIn: "?", resetsInSeconds: 1 }] } } } as any, [], "x");
    expect(out[0]!.usage?.windows[0]).toEqual({ name: "w", used: null, usedText: "lots", resetsIn: "?", resetsInSeconds: 1 });
    expect(projectProviders({ bare: {} } as any, [], "x")[0]!.usage).toBeNull();
  });
});
