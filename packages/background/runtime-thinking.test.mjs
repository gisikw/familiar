import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PI_THINKING_LEVELS } from "./protocol.mjs";

const sdk = process.env.PI_PACKAGE_DIR
  ? await import(
      pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js"))
    )
  : null;

test(
  "installed Pi applies every captured level, clamps by model, and rejects unknown persisted state",
  { skip: !sdk },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "background-runtime-thinking-"));
    const agentDir = join(root, "pi");
    mkdirSync(agentDir);
    const providerPath = join(root, "provider.ts");
    writeFileSync(
      providerPath,
      `export default function (pi) { pi.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture", baseUrl: "http://127.0.0.1:1/v1", models: [
        { id: "reasoning", name: "Reasoning", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
        { id: "plain", name: "Plain", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
      ] }); }`,
    );
    const settingsManager = sdk.SettingsManager.inMemory({
      compaction: { enabled: false },
    });
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    const loader = new sdk.DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      additionalExtensionPaths: [providerPath],
    });
    let session;
    try {
      await loader.reload();
      ({ session } = await sdk.createAgentSession({
        cwd: agentDir,
        agentDir,
        settingsManager,
        modelRuntime,
        resourceLoader: loader,
        sessionManager: sdk.SessionManager.create(agentDir, agentDir),
        noTools: "all",
      }));
      await session.bindExtensions({ mode: "print" });
      session.setThinkingLevel("high");
      const { configureBranchSession } = await import("./runtime-config.mjs");
      for (const thinkingLevel of PI_THINKING_LEVELS) {
        assert.equal(
          await configureBranchSession(session, modelRuntime, {
            model: { provider: "fixture", id: "reasoning" },
            thinkingLevel,
          }),
          thinkingLevel,
        );
      }
      assert.equal(
        await configureBranchSession(session, modelRuntime, {
          model: { provider: "fixture", id: "plain" },
          thinkingLevel: "max",
        }),
        "off",
        "Pi retains per-model clamping for a captured level",
      );
      for (const thinkingLevel of [
        undefined,
        null,
        "none",
        "disabled",
        "bogus",
      ])
        await assert.rejects(
          configureBranchSession(session, modelRuntime, {
            model: { provider: "fixture", id: "reasoning" },
            thinkingLevel,
          }),
          /thinking level/,
        );
    } finally {
      if (session) {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        session.dispose();
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
