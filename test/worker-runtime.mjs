// Worker runtime package check: proves packages.<system>.familiar-worker-runtime
// is the immutable public closure a fleet node may activate.
//
//   node test/worker-runtime.mjs <runtime-store-path> <integrations/pi/extensions>
//
// Runs inside the flake check sandbox (no network, scratch HOME). It asserts:
//   * one `bin` with the executables Agents rely on (per platform);
//   * the packaged `pi` is Familiar's patched 0.85.1 (downstream API present);
//   * the packaged `herdr` is the pinned 0.9.1 release;
//   * `share/familiar-worker/runtime.json` is schema 1 and describes exactly
//     the shipped Pi/Herdr components;
//   * the shipped extension tree equals the derived Tiamat worker-profile
//     artifact graph byte-for-byte (nothing extra, nothing missing);
//   * the profile template points at the shipped extension and carries no
//     provider, credential, or host-specific value.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const [runtime, extensionsRoot] = process.argv.slice(2);
assert.ok(runtime && extensionsRoot, "usage: worker-runtime.mjs <runtime> <extensions-src>");

const EXPECTED_PI = "0.85.1";
const EXPECTED_PI_PATCHES = ["invoke-command.patch", "runtime-control.patch", "model-bootstrap.patch"];
const EXPECTED_HERDR = "0.9.1";
const REQUIRED_BINS = [
  "pi", "herdr", "bash", "git", "python3", "rg", "fd", "jq", "ssh", "ssh-keygen",
  "ls", "env", "find", "grep", "sed", "awk",
  ...(process.platform === "linux" ? ["ps", "pgrep", "flock"] : []),
];

const executable = (path) => { accessSync(path, constants.X_OK); assert.ok(statSync(path).isFile(), `${path} is not a file`); };
const run = (bin, args) => execFileSync(join(runtime, "bin", bin), args, { encoding: "utf8", env: { HOME: process.env.HOME, PATH: join(runtime, "bin") } }).trim();

// 1. Single bin directory with every required tool.
assert.deepEqual(
  readdirSync(runtime).sort(),
  ["bin", "share"],
  "runtime exposes exactly bin and share",
);
for (const bin of REQUIRED_BINS) executable(join(runtime, "bin", bin));

// 2. Patched Pi: version plus the downstream API surface the Tiamat extension uses.
assert.equal(run("pi", ["--version"]), EXPECTED_PI);
const piRoot = join(dirname(dirname(realpathSync(join(runtime, "bin", "pi")))), "lib/node_modules/pi-monorepo");
const types = readFileSync(join(piRoot, "dist/core/extensions/types.d.ts"), "utf8");
for (const api of [
  "invokeExtensionCommand(name: string, args?: string): Promise<void>;",
  "registerModelBootstrap(handler: ModelBootstrapHandler): void;",
]) assert.ok(types.includes(api), `patched Pi API missing: ${api}`);

// 3. Pinned Herdr.
assert.match(run("herdr", ["--version"]), new RegExp(`\\b${EXPECTED_HERDR.replaceAll(".", "\\.")}\\b`));

// 4. Runtime metadata.
const share = join(runtime, "share", "familiar-worker");
const metadata = JSON.parse(readFileSync(join(share, "runtime.json"), "utf8"));
assert.equal(metadata.schema, 1);
assert.equal(metadata.name, "familiar-worker-runtime");
assert.match(metadata.familiar_rev, /^(?:[0-9a-f]{40}(?:-dirty)?|unknown)$/);
assert.equal(metadata.pi.version, EXPECTED_PI);
assert.deepEqual(metadata.pi.patches, EXPECTED_PI_PATCHES);
assert.match(metadata.pi.upstream_commit, /^[0-9a-f]{40}$/);
assert.equal(realpathSync(join(runtime, "bin", "pi")), realpathSync(join(metadata.pi.store_path, "bin", "pi")));
assert.equal(metadata.herdr.version, EXPECTED_HERDR);
assert.equal(realpathSync(join(runtime, "bin", "herdr")), realpathSync(join(metadata.herdr.store_path, "bin", "herdr")));
assert.ok(Array.isArray(metadata.tools) && metadata.tools.length > 0);
for (const tool of metadata.tools) {
  assert.match(tool.store_path, /^\/nix\/store\//);
  assert.ok(tool.name && tool.version, `tool record incomplete: ${JSON.stringify(tool)}`);
}
assert.deepEqual(metadata.extensions, ["tiamat"]);
assert.equal(metadata.profile_template, "share/familiar-worker/profile/settings.json");
const serialized = JSON.stringify(metadata);
for (const forbidden of [process.env.HOME, "token", "secret"]) {
  if (forbidden) assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `metadata mentions ${forbidden}`);
}

// 5. Extension tree equals the derived worker-profile artifact graph.
const { workerProfileArtifact } = await import(pathToFileURL(join(extensionsRoot, "agents", "transport.mjs")).href);
const artifact = workerProfileArtifact("tiamat/index.ts", extensionsRoot);
const shippedRoot = join(share, "extensions");
const shipped = {};
const extras = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    const rel = relative(shippedRoot, full);
    if (rel.endsWith(".ts")) shipped[rel] = readFileSync(full, "utf8");
    else if (entry.name !== "README.md") extras.push(rel);
  }
})(shippedRoot);
assert.deepEqual(extras, [], "runtime ships only .ts modules and READMEs");
assert.deepEqual(Object.keys(shipped).sort(), Object.keys(artifact.files).sort(), "shipped extension modules equal the derived artifact graph");
for (const [name, source] of Object.entries(artifact.files)) assert.equal(shipped[name], source, `${name} differs from the controller source`);

// 6. Profile template: public path only, resource trust off, no providers.
const settings = JSON.parse(readFileSync(join(share, "profile", "settings.json"), "utf8"));
assert.deepEqual(Object.keys(settings).sort(), ["defaultProjectTrust", "extensions", "lastChangelogVersion"]);
assert.deepEqual(settings.extensions, [join(shippedRoot, "tiamat")]);
assert.ok(statSync(join(settings.extensions[0], "index.ts")).isFile());
assert.equal(settings.defaultProjectTrust, "never");
assert.equal(settings.lastChangelogVersion, EXPECTED_PI);

console.log(`familiar-worker-runtime ok: pi ${EXPECTED_PI}, herdr ${EXPECTED_HERDR}, ${Object.keys(shipped).length} extension modules`);
