import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
if (!root) throw new Error("usage: model-bootstrap.test.mjs <installed pi root>");
const imp = (path) => import(pathToFileURL(join(root, "dist", path)).href);
const servicesApi = await imp("core/agent-session-services.js");
const { SessionManager } = await imp("core/session-manager.js");
const { SettingsManager } = await imp("core/settings-manager.js");

const model = (id) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 4096,
});

const temp = await mkdtemp(join(tmpdir(), "pi-model-bootstrap-"));
try {
  const make = async (name, defaultModel) => {
    const cwd = join(temp, name, "cwd");
    const agentDir = join(temp, name, "agent");
    await import("node:fs/promises").then(({ mkdir }) => Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
    ]));
    const settings = SettingsManager.create(cwd, agentDir);
    if (defaultModel) settings.setDefaultModelAndProvider("jit-exact", defaultModel);
    const requests = [];
    const services = await servicesApi.createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: settings,
      resourceLoaderOptions: {
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [{
          name: "bootstrap-proof",
          factory(pi) {
            pi.registerModelBootstrap(async (request) => {
              requests.push(request);
              await Promise.resolve();
              if (request.provider === "jit-exact" && request.modelId) {
                pi.registerProvider("jit-exact", {
                  baseUrl: "http://127.0.0.1:9",
                  apiKey: "test",
                  api: "openai-completions",
                  models: [model(request.modelId)],
                });
              } else if (!request.provider && !request.modelId) {
                pi.registerProvider("jit-list", {
                  baseUrl: "http://127.0.0.1:9",
                  apiKey: "test",
                  api: "openai-completions",
                  models: [model("health-seed")],
                });
              }
            });
          },
        }],
      },
    });
    return { services, requests, cwd };
  };

  const restored = await make("restored");
  const restoredManager = SessionManager.inMemory(restored.cwd);
  restoredManager.appendModelChange("jit-exact", "outside-mru");
  restoredManager.appendMessage({ role: "user", content: "saved", timestamp: Date.now() });
  await servicesApi.bootstrapExtensionModels(restored.services, {
    source: "session", provider: "jit-exact", modelId: "outside-mru",
  });
  assert(restored.services.modelRuntime.getModel("jit-exact", "outside-mru"));
  const resumed = await servicesApi.createAgentSessionFromServices({
    services: restored.services,
    sessionManager: restoredManager,
  });
  assert.equal(resumed.modelFallbackMessage, undefined);
  assert.equal(resumed.session.model?.id, "outside-mru");
  assert.deepEqual(restored.requests.map((r) => r.source), ["session"]);

  const defaults = await make("default", "brand-new");
  await servicesApi.bootstrapExtensionModels(defaults.services, {
    source: "default", provider: "jit-exact", modelId: "brand-new",
  });
  const fresh = await servicesApi.createAgentSessionFromServices({
    services: defaults.services,
    sessionManager: SessionManager.inMemory(defaults.cwd),
  });
  assert.equal(fresh.session.model?.provider, "jit-exact");
  assert.equal(fresh.session.model?.id, "brand-new");

  const listed = await make("list");
  await servicesApi.bootstrapExtensionModels(listed.services, { source: "list" });
  assert(listed.services.modelRuntime.getModel("jit-list", "health-seed"));
  assert.equal(listed.services.modelRuntime.getModels().filter((m) => m.provider === "jit-list").length, 1);

  const fuzzy = await make("fuzzy");
  await servicesApi.bootstrapExtensionModels(fuzzy.services, { source: "cli", modelId: "bare-pattern" });
  assert.equal(fuzzy.services.modelRuntime.getProvider("jit-exact"), undefined);

  // No configured default: identity-less, so only the same bounded seed.
  const seeded = await make("seeded");
  await servicesApi.bootstrapExtensionModels(seeded.services, { source: "default" });
  assert(seeded.services.modelRuntime.getModel("jit-list", "health-seed"));
  assert.equal(seeded.services.modelRuntime.getProvider("jit-exact"), undefined);

  console.log("model bootstrap runtime: ok");
} finally {
  await rm(temp, { recursive: true, force: true });
}
