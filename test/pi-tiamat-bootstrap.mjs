#!/usr/bin/env node
// Real, hermetic startup proof for Tiamat's JIT working set: the installed
// patched pi CLI, the real Tiamat extension, and a stub router on loopback.
// No live model call is made; the stub refuses inference with a 400 after the
// session has already started, so each case asserts the model pi actually
// resolved and bound, not a mock of resolution.
//
// Run under the pi dev shell so PI_PACKAGE_DIR points at the patched package:
//   nix develop .#pi -c <node> test/pi-tiamat-bootstrap.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageDir = process.env.PI_PACKAGE_DIR;
assert(packageDir, "PI_PACKAGE_DIR must identify the installed pi package");
const cli = join(packageDir, "dist", "cli.js");
const repo = resolve(new URL("..", import.meta.url).pathname);
const tiamatExtension = join(repo, "integrations", "pi", "extensions", "tiamat");

const model = (provider, id, api, extra = {}) => ({
  model: id,
  api,
  provider,
  fidelity: "full",
  availability: "available",
  context_window: 123_457,
  max_output_tokens: 4321,
  ...extra,
});
// Deliberately not first in sorted order: an arbitrary catalogue row must be
// startable, not just whatever a bounded seed would have chosen.
const CATALOG = [
  model("aa-first", "seed-row", "/anthropic/v1/messages"),
  model("tiamat", "claude-opus-5-5-interactive", "/anthropic/v1/messages"),
  model("work", "arbitrary-row-3", "/anthropic/v1/messages"),
  model("work", "other-row", "/anthropic/v1/messages"),
  model("shared", "duplicate-id", "/openai/v1/chat/completions"),
  model("shared", "duplicate-id", "/responses/v1/responses"),
  model("gone", "retired-row", "/openai/v1/chat/completions", {
    availability: "unavailable",
    reason: "quota",
  }),
];

const temp = mkdtempSync(join(tmpdir(), "familiar-tiamat-bootstrap-"));
// The stub router runs in its own process: pi is spawned synchronously, so an
// in-process listener could never answer the catalogue request.
const routerFile = join(temp, "router.mjs");
writeFileSync(
  routerFile,
  `import { createServer } from "node:http";
import { existsSync } from "node:fs";
const catalog = ${JSON.stringify(JSON.stringify(CATALOG))};
const outageFlag = process.env.OUTAGE_FLAG;
const server = createServer((req, res) => {
  if (req.url === "/tiamat/v1/models") {
    if (existsSync(outageFlag)) { res.writeHead(503).end("{}"); return; }
    res.writeHead(200, { "content-type": "application/json", etag: '"v1"' });
    res.end(req.method === "HEAD" ? undefined : catalog);
    return;
  }
  if (req.url === "/tiamat/v1/providers") {
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    return;
  }
  // Any inference attempt fails fast and non-retryably; startup is the subject.
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "stub router: inference refused" } }));
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`,
);
const outageFlag = join(temp, "outage");
const router = spawn(process.execPath, [routerFile], {
  env: { ...process.env, OUTAGE_FLAG: outageFlag },
  stdio: ["ignore", "pipe", "inherit"],
});
const port = await new Promise((done, fail) => {
  router.stdout.once("data", (chunk) => done(Number(String(chunk).trim())));
  router.once("exit", (code) => fail(new Error(`stub router exited: ${code}`)));
});
const baseUrl = `http://127.0.0.1:${port}`;

const agentDir = join(temp, "agent");
const cwd = join(temp, "cwd");
const sessionDir = join(temp, "sessions");
const probeOut = join(temp, "probe.jsonl");
const tokenFile = join(temp, "token");
for (const dir of [agentDir, cwd, sessionDir]) mkdirSync(dir, { recursive: true });
writeFileSync(tokenFile, "stub-token\n");

const probe = join(temp, "probe.mjs");
writeFileSync(
  probe,
  `import { appendFileSync } from "node:fs";
export default function (pi) {
  const record = (ctx) => appendFileSync(process.env.TIAMAT_PROBE_OUT, JSON.stringify({
    provider: ctx.model?.provider ?? null,
    id: ctx.model?.id ?? null,
    contextWindow: ctx.model?.contextWindow ?? null,
  }) + "\\n");
  pi.on("session_start", async (_event, ctx) => record(ctx));
  pi.on("model_select", async (_event, ctx) => record(ctx));
}
`,
);

const settings = (extra) =>
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: false },
      extensions: [tiamatExtension],
      ...extra,
    }),
  );
settings({});

const run = (...args) => {
  writeFileSync(probeOut, "");
  const result = spawnSync(
    process.execPath,
    [cli, "-e", probe, "--session-dir", sessionDir, ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        TIAMAT_PROBE_OUT: probeOut,
        FAMILIAR_TIAMAT_URL: baseUrl,
        FAMILIAR_TIAMAT_TOKEN_FILE: tokenFile,
        FAMILIAR_TIAMAT_POLL_SECONDS: "0",
        NO_COLOR: "1",
      },
    },
  );
  const bound = readFileSync(probeOut, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { ...result, bound };
};

const cases = [];
try {
  // 1. Exact CLI provider/model: the Golemd/print-worker contract.
  let result = run("--provider", "tiamat-anthropic-work", "--model", "arbitrary-row-3", "-p", "hi");
  assert.deepEqual(
    result.bound.at(-1),
    { provider: "tiamat-anthropic-work", id: "arbitrary-row-3", contextWindow: 123_457 },
    `exact CLI startup bound the wrong model: ${result.stderr}`,
  );
  assert.doesNotMatch(result.stderr, /Could not restore model|not found/i, result.stderr);
  cases.push("exact --provider/--model");

  // 2. Canonical single-flag PROVIDER/MODEL form.
  result = run("--model", "tiamat-responses-shared/duplicate-id", "-p", "hi");
  assert.deepEqual(result.bound.at(-1), {
    provider: "tiamat-responses-shared",
    id: "duplicate-id",
    contextWindow: 123_457,
  });
  cases.push("canonical --model route/model");

  // 3. Brand-new session on a configured Tiamat default, with no session history.
  settings({ defaultProvider: "tiamat-anthropic-work", defaultModel: "other-row" });
  result = run("-p", "hi");
  assert.deepEqual(result.bound.at(-1), {
    provider: "tiamat-anthropic-work",
    id: "other-row",
    contextWindow: 123_457,
  });
  cases.push("configured default");

  // 4. Resumed session: an arbitrary historical row, restored before resolution.
  const sessionFile = join(sessionDir, "resumed.jsonl");
  const stamp = new Date().toISOString();
  writeFileSync(
    sessionFile,
    [
      { type: "session", version: 2, id: "resumed", timestamp: stamp, cwd },
      {
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: stamp,
        message: { role: "user", content: "earlier", timestamp: stamp },
      },
      {
        type: "message",
        id: "e2",
        parentId: "e1",
        timestamp: stamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "earlier reply" }],
          provider: "tiamat-openai-shared",
          model: "duplicate-id",
          timestamp: stamp,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  result = run("--session", sessionFile, "-p", "hi");
  assert.deepEqual(result.bound.at(-1), {
    provider: "tiamat-openai-shared",
    id: "duplicate-id",
    contextWindow: 123_457,
  });
  assert.doesNotMatch(result.stderr, /Could not restore model/, result.stderr);
  cases.push("resumed session");

  // 5. Resident restart: --continue must bootstrap the exact historical route
  //    before Pi attempts normal session model restoration. Reproduce the live
  //    shape where both the semantic selection and model_change name the route.
  const restartFile = join(sessionDir, "resident-restart.jsonl");
  const restartStamp = new Date(Date.now() + 1000).toISOString();
  const restartProvider = "tiamat-anthropic-tiamat";
  const restartModel = "claude-opus-5-5-interactive";
  writeFileSync(
    restartFile,
    [
      {
        type: "session",
        version: 2,
        id: "resident-restart",
        timestamp: restartStamp,
        cwd,
      },
      {
        type: "message",
        id: "r1",
        parentId: null,
        timestamp: restartStamp,
        message: { role: "user", content: "earlier", timestamp: restartStamp },
      },
      {
        type: "message",
        id: "r2",
        parentId: "r1",
        timestamp: restartStamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "earlier reply" }],
          provider: restartProvider,
          model: restartModel,
          timestamp: restartStamp,
        },
      },
      {
        type: "model_change",
        id: "r3",
        parentId: "r2",
        timestamp: restartStamp,
        provider: restartProvider,
        modelId: restartModel,
      },
      {
        type: "custom",
        id: "r4",
        parentId: "r3",
        timestamp: restartStamp,
        customType: "familiar.tiamat.selection.v1",
        data: { provider: restartProvider, modelId: restartModel },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  writeFileSync(
    join(agentDir, "models-store.json"),
    JSON.stringify({
      "llama.cpp": {
        checkedAt: Date.now(),
        models: [
          {
            id: "local-fallback",
            name: "local-fallback",
            provider: "llama.cpp",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:1/v1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 4096,
          },
        ],
      },
    }),
  );
  settings({ defaultProvider: "llama.cpp", defaultModel: "local-fallback" });
  result = run("--continue", "-p", "hi");
  assert.deepEqual(
    result.bound.at(-1),
    { provider: restartProvider, id: restartModel, contextWindow: 123_457 },
    `resident restart bound the wrong model: ${result.stderr}`,
  );
  assert.doesNotMatch(result.stderr, /Could not restore model/, result.stderr);
  rmSync(join(agentDir, "models-store.json"), { force: true });
  cases.push("healthy resident restart restores historical route");

  // 6. If startup catalogue discovery fails, Pi initially binds an available
  //    local fallback. Once polling discovers the route, the extension must
  //    restore the session model rather than leave (and persist) the fallback.
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "llama.cpp": {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "local",
          models: [{ id: "local-fallback", contextWindow: 8192 }],
        },
      },
    }),
  );
  settings({
    defaultProvider: "tiamat-responses-shared",
    defaultModel: "duplicate-id",
  });
  writeFileSync(outageFlag, "");
  writeFileSync(probeOut, "");
  const recovering = spawn(
    process.execPath,
    [cli, "-e", tiamatExtension, "-e", probe, "--session-dir", sessionDir,
      "--session", sessionFile, "--mode", "rpc"],
    {
      cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        TIAMAT_PROBE_OUT: probeOut,
        FAMILIAR_TIAMAT_URL: baseUrl,
        FAMILIAR_TIAMAT_TOKEN_FILE: tokenFile,
        FAMILIAR_TIAMAT_POLL_SECONDS: "0.05",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let recoveryStderr = "";
  recovering.stderr.on("data", (chunk) => { recoveryStderr += chunk; });
  const waitForBound = async (provider, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = readFileSync(probeOut, "utf8").trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line));
      if (rows.some((row) => row.provider === provider)) return rows;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${provider}; stderr: ${recoveryStderr}`);
  };
  try {
    await waitForBound("llama.cpp");
    rmSync(outageFlag, { force: true });
    const rebound = await waitForBound("tiamat-openai-shared");
    assert.deepEqual(rebound.at(-1), {
      provider: "tiamat-openai-shared",
      id: "duplicate-id",
      contextWindow: 123_457,
    });
    const modelChanges = readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "model_change");
    const persisted = modelChanges.at(-1);
    assert.deepEqual(
      persisted && { provider: persisted.provider, modelId: persisted.modelId },
      { provider: "tiamat-openai-shared", modelId: "duplicate-id" },
    );
  } finally {
    recovering.kill();
    rmSync(outageFlag, { force: true });
    rmSync(join(agentDir, "models.json"), { force: true });
  }
  cases.push("late catalogue restores resumed model");

  // 7. Bounded list seed: exactly one deterministic Tiamat row, never the catalogue.
  result = run("--list-models");
  assert.equal(result.status, 0, result.stderr);
  const listed = result.stdout.split("\n").filter((line) => line.includes("tiamat-"));
  assert.equal(listed.length, 1, result.stdout);
  assert.match(listed[0], /tiamat-anthropic-aa-first\s+seed-row/);
  cases.push("bounded --list-models seed");

  // 8. A bare/fuzzy CLI pattern never expands the catalogue into pi.
  settings({});
  result = run("--model", "row", "-p", "hi");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not found|No models available|ambiguous/i, result.stderr);
  assert.deepEqual(result.bound, []);
  cases.push("bare pattern stays bounded");

  // 9. No configured default at all: one bounded seed, so a Tiamat-only box is
  //    never left without a model, and never with a catalogue.
  result = run("-p", "hi");
  assert.deepEqual(result.bound.at(-1), {
    provider: "tiamat-anthropic-aa-first",
    id: "seed-row",
    contextWindow: 123_457,
  });
  cases.push("bounded seed without a default");

  // 10. Router outage: startup degrades to pi's own resolution instead of failing closed.
  writeFileSync(outageFlag, "");
  settings({ defaultProvider: "tiamat-anthropic-work", defaultModel: "other-row" });
  result = run("-p", "hi");
  assert.notEqual(result.status, 0);
  assert.equal(
    result.bound.some(
      (bound) =>
        bound.provider === "tiamat-anthropic-work" &&
        bound.id === "other-row",
    ),
    false,
  );
  assert.doesNotMatch(result.stderr, /model bootstrap error/, result.stderr);
  assert.match(
    result.stderr,
    /No models available|not found|No API key found|error/i,
    result.stderr,
  );
  rmSync(outageFlag, { force: true });
  cases.push("router outage degrades");

  console.log(`pi tiamat bootstrap: ok (${cases.join(", ")})`);
} finally {
  router.kill();
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
