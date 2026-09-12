import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.argv[2];
if (!root) throw new Error("usage: model-bootstrap-cli.test.mjs <installed pi root>");
const temp = await mkdtemp(join(tmpdir(), "pi-bootstrap-cli-"));
try {
  const agentDir = join(temp, "agent");
  await mkdir(agentDir, { recursive: true });
  const log = join(temp, "requests.jsonl");
  const extension = join(temp, "bootstrap.mjs");
  await writeFile(extension, `
import { appendFileSync } from "node:fs";
const model = id => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 123456, maxTokens: 4321 });
export default function (pi) {
  pi.registerModelBootstrap(async request => {
    await Promise.resolve();
    appendFileSync(process.env.BOOTSTRAP_LOG, JSON.stringify(request) + "\\n");
    if (!request.provider && !request.modelId) pi.registerProvider("jit-list", { baseUrl: "http://127.0.0.1:9", apiKey: "x", api: "openai-completions", models: [model("health-seed")] });
    if (request.provider === "jit-exact" && request.modelId) pi.registerProvider("jit-exact", { baseUrl: "http://127.0.0.1:9", apiKey: "x", api: "openai-completions", models: [model(request.modelId)] });
  });
}
`);
  const cli = join(root, "dist", "cli.js");
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, BOOTSTRAP_LOG: log, NO_COLOR: "1" };
  const run = (...args) => spawnSync(process.execPath, [cli, "-e", extension, ...args], { cwd: temp, env, encoding: "utf8" });

  let result = run("--provider", "jit-exact", "--model", "outside-prior-mru", "--help");
  assert.equal(result.status, 0, result.stderr);
  let requests = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(requests.at(-1), { source: "cli", provider: "jit-exact", modelId: "outside-prior-mru" });

  // No configured default yet: an identity-less request, not a skipped phase.
  result = run("--help");
  assert.equal(result.status, 0, result.stderr);
  requests = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(requests.at(-1), { source: "default" });

  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "jit-exact", defaultModel: "brand-new-default" }));
  result = run("--help");
  assert.equal(result.status, 0, result.stderr);
  requests = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(requests.at(-1), { source: "default", provider: "jit-exact", modelId: "brand-new-default" });

  result = run("--list-models", "jit-list");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /jit-list\s+health-seed/);
  requests = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(requests.at(-1), { source: "list" });

  result = run("--model", "bare-fuzzy", "--help");
  assert.equal(result.status, 0, result.stderr);
  requests = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(requests.at(-1), { source: "cli", modelId: "bare-fuzzy" });
  console.log("model bootstrap CLI startup: ok");
} finally {
  await rm(temp, { recursive: true, force: true });
}
