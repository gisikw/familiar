import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import l1, { l1Enabled, parseNominations, renderGloss, runL1, L1_MESSAGE } from "./index.ts";

function fakeBin(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "l1-bin-"));
  const bin = join(dir, "l1");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

describe("l1 extension", () => {
  test("is off unless explicitly enabled", () => {
    expect(l1Enabled({})).toBe(false);
    expect(l1Enabled({ FAMILIAR_L1_ENABLED: "1" })).toBe(false);
    expect(l1Enabled({ FAMILIAR_L1_ENABLED: "true" })).toBe(true);
    const handlers: string[] = [];
    const prev = process.env.FAMILIAR_L1_ENABLED;
    delete process.env.FAMILIAR_L1_ENABLED;
    l1({ on: (name: string) => handlers.push(name) } as any);
    expect(handlers).toEqual([]);
    if (prev !== undefined) process.env.FAMILIAR_L1_ENABLED = prev;
  });

  test("runL1 returns stdout, and empty on failure or timeout", async () => {
    const ok = fakeBin(`cat >/dev/null; echo "Derek — employer: Vanta"`);
    expect((await runL1(["cue"], "derek", 1000, join(ok, "l1"))).trim()).toBe("Derek — employer: Vanta");
    const bad = fakeBin(`exit 3`);
    expect(await runL1(["cue"], "x", 1000, join(bad, "l1"))).toBe("");
    const slow = fakeBin(`sleep 5`);
    expect(await runL1(["cue"], "x", 100, join(slow, "l1"))).toBe("");
    expect(await runL1(["cue"], "x", 100, "/nonexistent/l1")).toBe("");
  });

  test("cue rides before_agent_start as one hidden message", async () => {
    const dir = fakeBin(`cat >/dev/null; printf 'Derek — employer: Vanta\\nAsh — wife\\n'`);
    const prev = { ...process.env };
    process.env.FAMILIAR_L1_ENABLED = "true";
    process.env.FAMILIAR_L1_BIN = dir;
    const h: Record<string, Function> = {};
    l1({ on: (name: string, fn: Function) => { h[name] = fn; } } as any);
    await h.input({ text: "lunch with derek" });
    const ctx = { sessionManager: { getSessionId: () => "s1" } };
    const r = await h.before_agent_start({}, ctx);
    expect(r.message.customType).toBe(L1_MESSAGE);
    expect(r.message.display).toBe(false);
    expect(r.message.content).toContain("Derek — employer: Vanta");
    expect(await h.before_agent_start({}, ctx)).toBeUndefined(); // no pending human text
    process.env = prev;
  });

  test("nominations parse strictly and cap at five", () => {
    expect(parseNominations("nope")).toBeNull();
    expect(parseNominations(`{"nominations":[]}`)).toEqual([]);
    const many = JSON.stringify({ nominations: Array.from({ length: 9 }, (_, i) => ({ entity: `e${i}` })) });
    expect(parseNominations("```json\n" + many + "\n```")!.length).toBe(5);
    expect(renderGloss(["a"])).toContain("- a");
  });
});
