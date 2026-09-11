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
  "background",
  "footer",
  "handoff",
  "identity",
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
const expectedFamiliarAgentTools = [
  "familiar_agents_abandon",
  "familiar_agents_answer",
  "familiar_agents_cancel",
  "familiar_agents_capabilities",
  "familiar_agents_dispatch",
  "familiar_agents_reconcile",
  "familiar_agents_resolve_intent",
  "familiar_agents_resolve_operation",
  "familiar_agents_settle",
  "familiar_agents_status",
  "familiar_agents_steer",
];
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
  const residentTools = toolNames(resident.extensions);
  assert.deepEqual(
    residentTools.filter((name) => name.startsWith("familiar_agents_")),
    [],
    "durable Familiar Agent tools must not be registered in resident Pi",
  );
  for (const name of [...expectedGolemTools, ...expectedUnrelatedTools]) {
    assert.ok(residentTools.includes(name), `resident tool remains registered: ${name}`);
  }

  // Load the retained implementation separately to make this test fail if the
  // actual dormant family grows without the resident-absence contract noticing.
  const dormant = await discoverAndLoadExtensions(
    [join(extensionRoot, "agents")],
    scratch,
    agentDir,
  );
  assert.deepEqual(
    dormant.errors,
    [],
    `dormant extension load errors: ${JSON.stringify(dormant.errors, null, 2)}`,
  );
  assert.deepEqual(
    toolNames(dormant.extensions).filter((name) => name.startsWith("familiar_agents_")),
    expectedFamiliarAgentTools,
  );

  console.log(
    `resident tool inventory: ${residentTools.length} tools; Familiar Agents absent, Golem and unrelated tools retained`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
// Some resident extensions own timers only after session_start. Keep this
// one-shot loader proof explicit regardless of future factory-only resources.
process.exit(0);
