import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

async function loader() {
  const packageDir = process.env.PI_PACKAGE_DIR;
  if (!packageDir) throw new Error("PI_PACKAGE_DIR is required (run in Familiar's pi or stt dev shell)");
  return import(join(packageDir, "dist/core/extensions/loader.js"));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "familiar-extension-layout-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const extensions = join(agentDir, "extensions");
  mkdirSync(join(extensions, "safe"), { recursive: true });
  writeFileSync(join(extensions, "safe", "index.ts"), "export default function () {}\n");
  writeFileSync(join(extensions, "safe", "helper.ts"), "throw new Error('nested helper was loaded')\n");
  writeFileSync(join(extensions, "safe", "bun-only.test.ts"), "import { test } from 'bun:test'; throw new Error(String(test))\n");
  return { root, agentDir, extensions };
}

describe("pi 0.84.1 extension discovery contract", () => {
  test("loads a child index but not colocated helper, test, or Bun-only TypeScript", async () => {
    const { root, agentDir } = fixture();
    const result = await (await loader()).discoverAndLoadExtensions([], root, agentDir);
    expect(result.errors).toEqual([]);
    expect(result.extensions.map((extension: { resolvedPath: string }) => extension.resolvedPath))
      .toEqual([join(agentDir, "extensions", "safe", "index.ts")]);
  });

  test("proves why root TypeScript is forbidden: pi attempts to load every root .ts", async () => {
    const { root, agentDir, extensions } = fixture();
    const poison = join(extensions, "root.test.ts");
    writeFileSync(poison, "throw new Error('root TypeScript auto-loaded')\nexport default function () {}\n");
    const result = await (await loader()).discoverAndLoadExtensions([], root, agentDir);
    expect(result.errors.map((error: { path: string }) => error.path)).toContain(poison);
    expect(result.errors.find((error: { path: string }) => error.path === poison)?.error)
      .toContain("root TypeScript auto-loaded");
  });

  test("Familiar exposes only named directory entrypoints and valid child -e paths", () => {
    const repo = resolve(import.meta.dir, "..", "..");
    const extensionRoot = join(repo, "extensions");
    const expected = [
      "anthropic-gateway", "claude-driver", "handoff", "identity", "ratelimit",
      "refamiliarize", "subagent", "subscriber", "telemetry", "timegap", "web",
      "worklist", "zip",
    ];
    const rootScripts = readdirSync(extensionRoot)
      .filter((name: string) => name.endsWith(".ts") || name.endsWith(".js"));
    expect(rootScripts).toEqual([]);
    const entrypoints = readdirSync(extensionRoot)
      .filter((name: string) => statSync(join(extensionRoot, name)).isDirectory())
      .filter((name: string) => {
        try { return statSync(join(extensionRoot, name, "index.ts")).isFile(); } catch { return false; }
      })
      .sort();
    expect(entrypoints).toEqual(expected.sort());

    // The child (pi) subagent's explicit `-e` set now lives in its own
    // dependency-free module (native-agent-args.ts). It must name valid child
    // entrypoints, in the authority-bearing order: anthropic-gateway (fallback)
    // before claude-driver (loopback authority), then web (route-neutral).
    const childArgs = readFileSync(join(extensionRoot, "subagent", "native-agent-args.ts"), "utf8");
    const positions = ["anthropic-gateway", "claude-driver", "web"].map((name) => {
      const marker = `ext("${name}")`;
      expect(childArgs).toContain(marker);
      expect(statSync(join(extensionRoot, name, "index.ts")).isFile()).toBe(true);
      return childArgs.indexOf(marker);
    });
    // Order is load-bearing: claude-driver must be loaded AFTER anthropic-gateway
    // (last same-id provider registration wins), and web stays last.
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);
  });
});
