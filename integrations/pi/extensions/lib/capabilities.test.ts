import { describe, expect, test } from "bun:test";
import { createCapabilityRegistry } from "./capabilities.ts";

describe("capability registry", () => {
  test("register, resolve, version, and dispose", () => {
    const registry = createCapabilityRegistry();
    const dispose = registry.register("cap", 1, { value: 1 });
    registry.register("cap", 2, { value: 2 });
    expect(registry.resolve<{ value: number }>("cap", 1)?.value).toBe(1);
    expect(registry.resolve<{ value: number }>("cap", 2)?.value).toBe(2);
    expect(registry.resolve("cap", 3)).toBeUndefined();
    dispose();
    expect(registry.resolve("cap", 1)).toBeUndefined();
  });

  test("a stale disposer cannot remove a replacement", () => {
    const registry = createCapabilityRegistry();
    const stale = registry.register("cap", 1, "old");
    registry.register("cap", 1, "new");
    stale();
    expect(registry.resolve("cap", 1)).toBe("new");
  });
});
