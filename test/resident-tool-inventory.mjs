#!/usr/bin/env node
// Real pinned Pi 0.85.1 loader proof for the ordinary resident extension set.
// This never starts a session, provider, owner, relay, or live action.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageDir = process.env.PI_PACKAGE_DIR;
assert(packageDir, "PI_PACKAGE_DIR must identify the installed pi package");
const { discoverAndLoadExtensions } = await import(
  pathToFileURL(join(packageDir, "dist/core/extensions/loader.js"))
);
const repo = resolve(new URL("..", import.meta.url).pathname);
const extensionRoot = join(repo, "integrations", "pi", "extensions");
const scratch = mkdtempSync(join(tmpdir(), "familiar-resident-tools-"));
const agentDir = join(scratch, "agent");
mkdirSync(agentDir, { recursive: true });

const residentNames = [
  "agents",
  "background",
  "footer",
  "handoff",
  "identity",
  "imp",
  "private",
  "stuff",
  "subscriber",
  "tiamat",
  "web",
  "worklist",
  "zip",
  "wake",
];
const golemExtension = join(repo, "contrib", "familiar", "pi", "agents");
const expectedGolemTools = [
  "agents_answer",
  "agents_artifact_fetch",
  "agents_artifacts",
  "agents_cancel",
  "agents_capabilities",
  "agents_dispatch",
  "agents_status",
  "agents_steer",
];
const expectedUnrelatedTools = [
  "ack_worklist",
  "clear",
  "fetch",
  "mark",
  "marks",
  "search",
  "set_attention",
  "wake",
  "zip",
];

const toolNames = (extensions) =>
  [...new Set(extensions.flatMap((extension) => [...extension.tools.keys()]))].sort();

try {
  const resident = await discoverAndLoadExtensions(
    [
      ...residentNames.map((name) => join(extensionRoot, name)),
      golemExtension,
    ],
    scratch,
    agentDir,
  );
  assert.deepEqual(
    resident.errors,
    [],
    `resident extension load errors: ${JSON.stringify(resident.errors, null, 2)}`,
  );
  const residentPaths = resident.extensions.map((extension) => extension.resolvedPath);
  for (const name of residentNames) {
    assert.ok(
      residentPaths.includes(join(extensionRoot, name, "index.ts")),
      `unrelated resident extension remains loaded: ${name}`,
    );
  }
  assert.ok(
    residentPaths.includes(join(golemExtension, "index.ts")),
    "Golem agents extension remains loaded",
  );
  assert.ok(
    residentPaths.includes(join(extensionRoot, "agents", "index.ts")),
    "durable Familiar Agents owner implementation is loaded",
  );
  assert.ok(
    residentPaths.includes(join(extensionRoot, "imp", "index.ts")),
    "sole resident Imp ingress implementation is loaded",
  );
  const residentTools = toolNames(resident.extensions);
  assert.deepEqual(
    residentTools.filter((name) => name.startsWith("familiar_agents_")),
    [],
    "durable Familiar Agent tools must not be registered in resident Pi",
  );
  for (const name of [...expectedGolemTools, ...expectedUnrelatedTools]) {
    assert.ok(residentTools.includes(name), `resident tool remains registered: ${name}`);
  }

  // The loaded owner implementation itself must remain schema-free; there is
  // no dormant first-class family to accidentally activate in another loader.
  const agentsExtension = resident.extensions.find(
    (extension) => extension.resolvedPath === join(extensionRoot, "agents", "index.ts"),
  );
  assert.ok(agentsExtension);
  assert.deepEqual(
    [...agentsExtension.tools.keys()].filter((name) => name.startsWith("familiar_agents_")),
    [],
  );

  console.log(
    `resident tool inventory: ${residentTools.length} tools; Familiar Agents owner + Imp loaded without familiar_agents_ tools; Golem unchanged`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
// Some resident extensions own timers only after session_start. Keep this
// one-shot loader proof explicit regardless of future factory-only resources.
process.exit(0);
