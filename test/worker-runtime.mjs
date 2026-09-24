// Worker runtime package check: proves packages.<system>.familiar-worker-runtime
// is the immutable public closure a fleet node may activate.
//
//   node test/worker-runtime.mjs <runtime-store-path> <integrations/pi/extensions>
//
// Runs inside the flake check sandbox (no network, scratch HOME). It asserts:
//   * one `bin` with the executables Agents rely on (per platform);
//   * `bin/pi` fails closed on every missing/invalid Tiamat launch input and
//     execs Familiar's immutable patched Pi 0.85.1 on the valid path;
//   * the packaged `herdr` is the pinned 0.9.1 release from the pinned input;
//   * `share/familiar-worker/runtime.json` is schema 1 and describes exactly
//     the shipped Pi/Herdr components;
//   * the shipped extension tree equals the derived Tiamat worker-profile
//     artifact graph byte-for-byte (nothing extra, nothing missing);
//   * the profile template points at the shipped extension and carries no
//     provider, credential, or host-specific value.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const [runtime, extensionsRoot] = process.argv.slice(2);
assert.ok(runtime && extensionsRoot, "usage: worker-runtime.mjs <runtime> <extensions-src>");

const EXPECTED_PI = "0.85.1";
const EXPECTED_PI_PATCHES = ["invoke-command.patch", "model-bootstrap.patch"];
const EXPECTED_HERDR = "0.9.1";
const EXPECTED_HERDR_NIX_REV = "2bcfa02424385730d0c65cfa8cd355bb3afecef8";
const REQUIRED_BINS = [
  "pi", "herdr", "bash", "git", "python3", "rg", "fd", "jq", "ssh", "ssh-keygen",
  "ls", "env", "find", "grep", "sed", "awk",
  ...(process.platform === "linux" ? ["ps", "pgrep", "flock"] : []),
];

const executable = (path) => { accessSync(path, constants.X_OK); assert.ok(statSync(path).isFile(), `${path} is not a file`); };
const tokenFile = join(process.env.HOME, "tiamat-token");
writeFileSync(tokenFile, "dummy-token\n", { mode: 0o600 });
const launchEnv = {
  HOME: process.env.HOME,
  PATH: join(runtime, "bin"),
  FAMILIAR_TIAMAT_URL: "https://router.invalid",
  FAMILIAR_TIAMAT_TOKEN_FILE: tokenFile,
};
const run = (bin, args, env = launchEnv) => execFileSync(join(runtime, "bin", bin), args, { encoding: "utf8", env }).trim();
const piFailure = (env, message) => {
  const result = spawnSync(join(runtime, "bin", "pi"), ["--version"], { encoding: "utf8", env });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `Failed to start pi: ${message}\n`);
};

// 1. Single bin directory with every required tool.
assert.deepEqual(
  readdirSync(runtime).sort(),
  ["bin", "share"],
  "runtime exposes exactly bin and share",
);
for (const bin of REQUIRED_BINS) executable(join(runtime, "bin", bin));

// 2. Fleet entrypoint: fail closed for each bad launch input, then preserve a
// successful invocation of the immutable patched Pi.
const baseEnv = { HOME: process.env.HOME, PATH: join(runtime, "bin") };
piFailure(baseEnv, "missing FAMILIAR_TIAMAT_URL");
piFailure({ ...baseEnv, FAMILIAR_TIAMAT_URL: launchEnv.FAMILIAR_TIAMAT_URL }, "missing FAMILIAR_TIAMAT_TOKEN_FILE");
piFailure({ ...launchEnv, FAMILIAR_TIAMAT_TOKEN_FILE: process.env.HOME }, "FAMILIAR_TIAMAT_TOKEN_FILE is not a regular file");
const unreadableToken = join(process.env.HOME, "unreadable-token");
writeFileSync(unreadableToken, "dummy-token\n", { mode: 0o600 });
chmodSync(unreadableToken, 0o000);
piFailure({ ...launchEnv, FAMILIAR_TIAMAT_TOKEN_FILE: unreadableToken }, "FAMILIAR_TIAMAT_TOKEN_FILE is not readable");
chmodSync(unreadableToken, 0o600);
const emptyToken = join(process.env.HOME, "empty-token");
writeFileSync(emptyToken, "", { mode: 0o600 });
piFailure({ ...launchEnv, FAMILIAR_TIAMAT_TOKEN_FILE: emptyToken }, "FAMILIAR_TIAMAT_TOKEN_FILE is empty");
assert.equal(run("pi", ["--version"]), EXPECTED_PI);

// The wrapper success path reaches the patched package, whose downstream API
// surface is the one consumed by the shipped Tiamat extension.
const metadataPath = join(runtime, "share", "familiar-worker", "runtime.json");
const earlyMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));
const piRoot = join(earlyMetadata.pi.store_path, "lib/node_modules/pi-monorepo");
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
assert.equal(metadata.pi.entrypoint, "bin/pi");
assert.equal(metadata.pi.fail_closed_tiamat, true);
assert.notEqual(realpathSync(join(runtime, "bin", "pi")), realpathSync(join(metadata.pi.store_path, "bin", "pi")));
assert.equal(metadata.herdr.version, EXPECTED_HERDR);
assert.equal(metadata.herdr.nix_input_revision, EXPECTED_HERDR_NIX_REV);
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
