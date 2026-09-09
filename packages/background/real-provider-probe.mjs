// Explicit manual acceptance probe, never run by CI. Uses the existing job's
// authorized provider adapter without logging, copying, or persisting its token.
// No Pi subprocesses, tools, user transcript, Presence, or project resources.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

if (process.env.BACKGROUND_REAL_PROVIDER_PROBE !== "1")
  throw new Error("explicit probe opt-in required");
for (const key of [
  "PI_PACKAGE_DIR",
  "BACKGROUND_PROVIDER_ADAPTER",
  "PI_PROVIDER",
  "PI_MODEL",
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
let proven = false;
let stage = "construct";
try {
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
    await session.bindExtensions({ mode: "print" });
    stage = `model-${n}`;
    const model = modelRuntime.getModel(
      process.env.PI_PROVIDER,
      process.env.PI_MODEL,
    );
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
  const start = Date.now();
  while (!responses.has(1) || !responses.has(2)) {
    if (Date.now() - start > 45000) throw new Error("branch response deadline");
    await new Promise((r) => setTimeout(r, 10));
  }
  stage = "branch-overlap";
  assert.ok(
    sessions[1].isStreaming && sessions[2].isStreaming,
    "both real branch streams must be active before foreground inference",
  );
  stage = "foreground-inference";
  await sessions[0].prompt(
    "Synthetic concurrency test only. Reply exactly READY.",
  );
  const fg = sessions[0].messages.at(-1);
  assert.equal(fg.role, "assistant");
  assert.equal(fg.stopReason, "stop");
  assert.ok(JSON.stringify(fg.content).includes("READY"));
  stage = "foreground-overlap";
  proven = sessions[1].isStreaming && sessions[2].isStreaming;
  await Promise.all(sessions.slice(1).map((s) => s.abort()));
  await Promise.all(branches);
  assert.ok(
    proven,
    "foreground must complete while both branches remain active",
  );
  console.log(
    JSON.stringify({
      proven,
      sessions: 3,
      independentRuntimes: true,
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
  for (const session of sessions) session.dispose();
  rmSync(root, { recursive: true, force: true });
}
