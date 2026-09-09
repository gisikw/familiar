import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WorkstreamStore } from "./store.mjs";
const sdk = process.env.PI_PACKAGE_DIR ? await import(pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js"))) : null;
const ui = process.env.FAMILIAR_UI_SOURCE;
const until = async (fn) => { for (let i = 0; i < 500; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error("isolated host deadline"); };

test("isolated Familiar owner birth: browser HTTP admission -> real SDK branch/report tool -> canonical merge and teardown", { skip: !sdk || !ui, timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "background-integrated-"));
  const prior = {};
  const set = (key, value) => { prior[key] = process.env[key]; process.env[key] = value; };
  const requests = [];
  const errors = [];
  const notices = [];
  let session;
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const request = JSON.parse(text); requests.push(request);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const args = JSON.stringify({ reportId: "refusal", disposition: "refused", summary: "Choose a target before proceeding", questions: ["Which target?"], requestedRejoin: true });
    const delta = { role: "assistant", tool_calls: [{ index: 0, id: "call-report", type: "function", function: { name: "background_report", arguments: args } }] };
    res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "synthetic", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const agentDir = join(root, "pi"); mkdirSync(agentDir);
  const providerPath = join(root, "provider.ts");
  writeFileSync(providerPath, `export default function(pi) { pi.registerProvider("fixture", { baseUrl: "http://127.0.0.1:${server.address().port}/v1", api: "openai-completions", apiKey: "fixture", models: [{ id: "synthetic", name: "Synthetic", reasoning: true, input: ["text", "image"], contextWindow: 32768, maxTokens: 1024, cost: { input:0, output:0, cacheRead:0, cacheWrite:0 } }, { id: "synthetic-later", name: "Synthetic Later", reasoning: true, input: ["text", "image"], contextWindow: 32768, maxTokens: 1024, cost: { input:0, output:0, cacheRead:0, cacheWrite:0 } }] }); }`);
  set("FAMILIAR_BACKGROUND_ENABLE", "1");
  set("FAMILIAR_BACKGROUND_STATE_DIR", join(root, "background"));
  set("FAMILIAR_BACKGROUND_PROVIDER_EXTENSION", providerPath);
  set("FAMILIAR_UI_DESCRIPTOR", join(root, "bridge.json"));
  set("FAMILIAR_UI_ORIGIN", "http://localhost:5173");
  set("FAMILIAR_UI_ATTACHMENT_DIR", join(root, "attachments"));
  set("GOLEM_ENDPOINT", "http://127.0.0.1:1"); // no dispatched children; no resident golemd traffic
  try {
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
    const loader = new sdk.DefaultResourceLoader({ cwd: agentDir, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }), additionalExtensionPaths: [providerPath, resolve("integrations/pi/extensions/background/index.ts"), join(ui, "packages/extension/src/index.ts")] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await sdk.createAgentSession({ cwd: agentDir, agentDir, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: sdk.SessionManager.create(agentDir, agentDir), noTools: "builtin" }));
    // Seed mixed persisted state before session_start constructs the production
    // extension host. None of these archived invalid rows may reach a runtime.
    const stateRoot = join(root, "background");
    const seed = new WorkstreamStore(stateRoot);
    const validSeed = seed.create({ admissionId: "valid-seed", parentSessionId: session.sessionId, parentLeafId: session.sessionManager.getLeafId(), projectId: "test", content: "valid seed" }).record;
    seed.prepare(validSeed.id, validSeed.generation, { file: "/synthetic/seed.jsonl", sha256: "f".repeat(64), sessionId: "seed-branch" }, undefined, { provider: "fixture", id: "synthetic" }, "high");
    seed.admitReceipt(validSeed.id, validSeed.generation, { userEntryId: "seed-user", controlEntryId: "seed-control" });
    const source = seed.get(validSeed.id);
    const corruptBodies = new Map();
    const corrupt = (name, mutate, body) => {
      const record = structuredClone(source);
      record.id = `integrated-invalid-${name}`;
      record.admission.admissionId = `integrated-fenced-${name}`;
      mutate?.(record);
      const encoded = body ?? JSON.stringify(record);
      seed.db.prepare("INSERT INTO workstreams VALUES (?,?,?,?,?)").run(record.id, record.admission.admissionId, record.admission.digest, record.revision, encoded);
      corruptBodies.set(record.id, encoded);
    };
    corrupt("json", null, "{");
    corrupt("v2", (record) => { record.version = 2; });
    corrupt("thinking", (record) => { delete record.thinkingLevel; });
    corrupt("model", (record) => { record.model = { provider: "fixture", id: null }; });
    seed.close();
    session.extensionRunner.onError((error) => errors.push(error));
    await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error), uiContext: { ...session.extensionRunner.getUIContext(), notify: (message) => notices.push(message) } });
    await session.setModel(modelRuntime.getModel("fixture", "synthetic"));
    session.setThinkingLevel("high");
    assert.equal(session.thinkingLevel, "high");
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.ok(existsSync(join(root, "bridge.json")), `production UI extension started: ${JSON.stringify(notices)}`);
    const descriptor = JSON.parse(readFileSync(join(root, "bridge.json"), "utf8"));
    const headers = { Origin: "http://localhost:5173", Authorization: `Bearer ${descriptor.token}`, "Content-Type": "application/json" };
    const body = { v: 1, id: crypto.randomUUID(), epoch: descriptor.epoch, sessionId: session.sessionId, action: { type: "message.send", text: "exact browser request", delivery: "immediate", background: { admissionId: "browser-admission", parentSessionId: session.sessionId, parentLeafId: session.sessionManager.getLeafId(), projectId: "test" } } };
    const response = await fetch(`${descriptor.url}/v1/actions`, { method: "POST", headers, body: JSON.stringify(body) });
    const receipt = await response.json();
    assert.equal(response.status, 200, JSON.stringify(receipt));
    assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
    // Change both foreground controls after the synchronous admission. The
    // deferred branch must still use the captured pair.
    await session.setModel(modelRuntime.getModel("fixture", "synthetic-later"));
    session.setThinkingLevel("low");
    await until(() => session.messages.some((m) => m.role === "custom" && m.customType === "familiar.background.merge"));
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(requests.length, 1, "only branch provider inference occurred");
    assert.equal(requests[0].model, "synthetic");
    assert.equal(requests[0].reasoning_effort, "high");
    assert.ok(requests[0].tools.some((t) => t.function.name === "background_report"));
    assert.ok(!requests[0].tools.some((t) => t.function.name === "background"));
    assert.equal(session.messages.filter((m) => m.role === "assistant").length, 0, "no fabricated foreground assent");
    assert.equal(JSON.parse(session.messages.at(-1).content).disposition, "refused");
    assert.equal(sdk.SessionManager.open(session.sessionFile).buildSessionContext().messages.at(-1).content, session.messages.at(-1).content);
    const database = new DatabaseSync(join(root, "background", "workstreams.sqlite"));
    const record = JSON.parse(database.prepare("SELECT body FROM workstreams WHERE admission_id=?").get("browser-admission").body);
    assert.equal(JSON.parse(database.prepare("SELECT body FROM workstreams WHERE id=?").get(validSeed.id).body).status, "orphaned");
    for (const [id, body] of corruptBodies)
      assert.equal(database.prepare("SELECT body FROM workstreams WHERE id=?").get(id).body, body);
    database.close();
    assert.deepEqual(record.model, { provider: "fixture", id: "synthetic" });
    assert.equal(record.thinkingLevel, "high");
    const branchEntries = readFileSync(record.archive.file, "utf8").trimEnd().split("\n").map(JSON.parse);
    assert.ok(branchEntries.some((entry) => entry.type === "model_change" && entry.provider === "fixture" && entry.modelId === "synthetic"));
    assert.ok(branchEntries.some((entry) => entry.type === "thinking_level_change" && entry.thinkingLevel === "high"));
  } finally {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    server.closeAllConnections(); await new Promise((r) => server.close(r));
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
