#!/usr/bin/env node
// Real pi 0.84.1 loader smoke. Run under the pi dev shell (Node, no Bun globals).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageDir = process.env.PI_PACKAGE_DIR;
assert(packageDir, "PI_PACKAGE_DIR must identify the installed pi package");
const { discoverAndLoadExtensions } = await import(pathToFileURL(join(packageDir, "dist/core/extensions/loader.js")));
const repo = resolve(new URL("..", import.meta.url).pathname);
const scratch = mkdtempSync(join(tmpdir(), "familiar-pi-loader-"));
const agentDir = join(scratch, "agent");
mkdirSync(agentDir, { recursive: true });
try {
  const result = await discoverAndLoadExtensions([join(repo, "integrations", "pi", "extensions")], scratch, agentDir);
  assert.deepEqual(result.errors, [], `extension load errors: ${JSON.stringify(result.errors, null, 2)}`);
  const loaded = result.extensions.map((extension) => extension.resolvedPath).sort();
  const expected = [
    "handoff", "identity", "stuff", "subscriber", "telemetry", "tiamat", "timegap", "web", "worklist", "zip",
  ].map((name) => join(repo, "integrations", "pi", "extensions", name, "index.ts")).sort();
  assert.deepEqual(loaded, expected);
  assert.equal(typeof globalThis.Bun, "undefined", "smoke must run without Bun globals");
  console.log(`pi loader smoke: loaded ${loaded.length} index.ts entrypoints; Bun absent`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
// Some extensions intentionally own polling timers until session_shutdown. This
// one-shot bootstrap has no ExtensionRunner lifecycle to emit that event.
process.exit(0);
