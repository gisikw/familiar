// Explicit manual acceptance probe, never run by CI. Uses the existing job's
// authorized provider adapter without logging, copying, or persisting its token.
// No Pi subprocesses, tools, user transcript, Presence, or project resources.
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { ProbeProgress, discoverProbeModel } from "./probe-progress.mjs";
import { discoverCatalogRow } from "./probe-catalog.mjs";

if (process.env.BACKGROUND_REAL_PROVIDER_PROBE !== "1")
  throw new Error("explicit probe opt-in required");
for (const key of [
  "PI_PACKAGE_DIR",
  "BACKGROUND_PROVIDER_ADAPTER",
  "PI_PROVIDER",
])
  if (!process.env[key]) throw new Error(`missing ${key}`);
const sdk = await import(
  pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js")).href
);
const root = mkdtempSync(join(tmpdir(), "background-real-provider-"));
const sessions = [],
  responses = new Set(),
  statuses = {};
const deadline = setTimeout(() => {
  for (const session of sessions) void session.abort();
}, 60000);
const progress = new ProbeProgress();
const pending = [];
let selectedModel;
let proven = false;
let stage = "construct";
const originalSnapshot = process.env.GOLEM_TIAMAT_SNAPSHOT_FILE;
try {
  if (process.env.BACKGROUND_PROBE_DISCOVER_CATALOG === "1") {
    stage = "catalog-discovery";
    const row = await discoverCatalogRow({
      baseUrl: process.env.GOLEM_TIAMAT_URL,
      token: readFileSync(process.env.GOLEM_TIAMAT_TOKEN_FILE, "utf8").trim(),
      authorized: JSON.parse(readFileSync(originalSnapshot, "utf8")),
      modelId: process.env.PI_MODEL,
    });
    const snapshot = join(root, "catalog.json");
    writeFileSync(snapshot, JSON.stringify([row]), { mode: 0o600 });
    process.env.GOLEM_TIAMAT_SNAPSHOT_FILE = snapshot;
  }
  for (let n = 0; n < 3; n++) {
    const cwd = join(root, String(n));
    mkdirSync(cwd);
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(cwd, "auth.json"),
      modelsPath: join(cwd, "models.json"),
      modelsStorePath: join(cwd, "models-store.json"),
      allowModelNetwork: false,
    });
    const settingsManager = sdk.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      additionalExtensionPaths: [process.env.BACKGROUND_PROVIDER_ADAPTER],
      extensionFactories: [
        {
          name: "probe-observer",
          factory: (pi) => {
            pi.on("after_provider_response", (event) => {
              responses.add(n);
              statuses[n] = event.status;
            });
          },
        },
      ],
    });
    stage = `loader-${n}`;
    await loader.reload();
    stage = `session-${n}`;
    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir: cwd,
      resourceLoader: loader,
      modelRuntime,
      settingsManager,
      sessionManager: sdk.SessionManager.inMemory(cwd),
      noTools: "all",
    });
    sessions.push(session);
    session.subscribe((event) => progress.observe(n, event));
    await session.bindExtensions({ mode: "print" });
    stage = `model-${n}`;
    const model = await discoverProbeModel(
      modelRuntime,
      process.env.PI_PROVIDER,
      selectedModel ?? process.env.PI_MODEL,
    );
    if (selectedModel && model.id !== selectedModel)
      throw new Error("independent runtime model catalog changed");
    selectedModel = model.id;
    if (!model)
      throw new Error("authorized model not available in independent runtime");
    await session.setModel(model);
    session.setThinkingLevel("off");
  }
  stage = "branch-inference";
  const branches = [
    sessions[1].prompt(
      "Synthetic concurrency test only. Output the integers 1 through 500, one per line, and nothing else. Do not use tools.",
    ),
    sessions[2].prompt(
      "Synthetic concurrency test only. Output the integers 501 through 1000, one per line, and nothing else. Do not use tools.",
    ),
  ];
  // Attach rejection handlers immediately, including on setup/overlap failure.
  pending.push(...branches.map((branch) => branch.catch(() => {
    throw new Error("branch inference rejected");
  })));
  for (const branch of pending) void branch.catch(() => {});
  const start = Date.now();
  while (!progress.branchesActive()) {
    if (progress.states.slice(1).some((state) => state.ended))
      throw new Error("branch ended before overlap");
    if (Date.now() - start > 45000) throw new Error("branch response deadline");
    await new Promise((r) => setTimeout(r, 10));
  }
  stage = "branch-overlap";
  assert.ok(
    sessions[1].isStreaming && sessions[2].isStreaming,
    "both real branch streams must be active before foreground inference",
  );
  stage = "foreground-inference";
  const foregroundStart = Date.now();
  await sessions[0].prompt(
    "Synthetic concurrency test only. Reply exactly READY.",
  );
  const foregroundLatencyMs = Date.now() - foregroundStart;
  assert.ok(foregroundLatencyMs <= 10000, "foreground inference exceeded 10s responsiveness bound");
  const fg = sessions[0].messages.at(-1);
  assert.equal(fg.role, "assistant");
  assert.equal(fg.stopReason, "stop");
  assert.ok(JSON.stringify(fg.content).includes("READY"));
  stage = "foreground-overlap";
  proven = progress.branchesActive() && sessions[1].isStreaming && sessions[2].isStreaming;
  await Promise.all(sessions.slice(1).map((s) => s.abort()));
  await Promise.all(pending);
  assert.ok(
    proven,
    "foreground must complete while both branches remain active",
  );
  console.log(
    JSON.stringify({
      proven,
      sessions: 3,
      independentRuntimes: true,
      model: selectedModel,
      branchTextDeltas: progress.states.slice(1).map((state) => state.deltas),
      foregroundLatencyMs,
      extraPiProcesses: 0,
      tools: 0,
    }),
  );
} catch {
  // Do not print provider exceptions; their request URLs/headers can be sensitive.
  console.error(
    JSON.stringify({
      proven: false,
      stage,
      responses: [...responses],
      statuses,
      errorClasses: sessions.map((s) => {
        const message = s.messages.at(-1)?.errorMessage ?? "";
        return [
          "reasoning",
          "unsupported",
          "rate limit",
          "authentication",
          "max_output_tokens",
          "permission",
          "model",
          "organization",
        ].filter((term) => message.toLowerCase().includes(term));
      }),
      outcomes: sessions.map((s) =>
        ["stop", "error", "aborted", "length", "toolUse"].includes(
          s.messages.at(-1)?.stopReason,
        )
          ? s.messages.at(-1).stopReason
          : "pending",
      ),
      note: "No provider error payload logged",
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await Promise.all(sessions.map((s) => s.abort()));
  await Promise.allSettled(pending);
  for (const session of sessions) session.dispose();
  if (originalSnapshot === undefined) delete process.env.GOLEM_TIAMAT_SNAPSHOT_FILE;
  else process.env.GOLEM_TIAMAT_SNAPSHOT_FILE = originalSnapshot;
  rmSync(root, { recursive: true, force: true });
}
