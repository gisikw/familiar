import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mergeContent } from "./protocol.mjs";

// Always test the installed compiled pinned Pi, not a source mock/transpiler.
const root = process.env.PI_PACKAGE_DIR;
const sdk = root
  ? await import(pathToFileURL(join(root, "dist/index.js")).href)
  : null;
test(
  "compiled Pi converter preserves the complete attributed merge packet",
  { skip: !sdk },
  async () => {
    const { convertToLlm } = await import(
      pathToFileURL(join(root, "dist/core/messages.js")).href
    );
    const packet = {
      packetId: "packet",
      reportId: "report",
      disposition: "narrowed",
      summary: "scoped result",
      decisions: ["decision"],
      durableContext: ["durable"],
      risks: ["risk"],
      questions: [],
      changedArtifacts: ["file"],
      integrationRef: "commit",
      requestedRejoin: true,
    };
    const content = mergeContent(
      {
        id: "workstream",
        generation: 1,
        admission: { parentSessionId: "parent", parentLeafId: "leaf" },
        foregroundUserEntryId: "user",
        foregroundControlEntryId: "control",
        archive: { sessionId: "branch", file: "/synthetic/archive.jsonl" },
      },
      packet,
      "advanced-leaf",
    );
    const converted = convertToLlm([
      {
        role: "custom",
        customType: "familiar.background.merge",
        content,
        display: true,
        timestamp: 1,
        details: { intentionallyDropped: "metadata-only" },
      },
    ]);
    const encoded = JSON.stringify(converted);
    for (const value of [
      "decision",
      "durable",
      "risk",
      "commit",
      "/synthetic/archive.jsonl",
      "broker-merge",
      "narrowed",
      "advanced-leaf",
    ]) {
      assert.ok(encoded.includes(value), value);
    }
    assert.ok(!encoded.includes("metadata-only"));
    assert.ok(converted.every((message) => message.role !== "assistant"));
  },
);

const until = async (fn) => {
  for (let i = 0; i < 500; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("provider barrier deadline");
};

test(
  "compiled Pi: foreground provider stream completes while two independent branches stream",
  { skip: !sdk, timeout: 30000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "background-pi-"));
    const held = new Map(),
      received = [],
      sessions = [];
    const server = createServer(async (req, res) => {
      let data = "";
      for await (const chunk of req) data += chunk;
      const body = JSON.parse(data);
      received.push(body);
      const prompt = body.messages
        .filter((m) => m.role === "user")
        .at(-1).content;
      const name =
        typeof prompt === "string"
          ? prompt
          : prompt.find((p) => p.type === "text").text;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: name, object: "chat.completion.chunk", created: 1, model: "synthetic", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      frame({ role: "assistant", content: `partial-${name}` });
      const finish = () => {
        frame({ content: `-complete-${name}` }, "stop");
        res.end("data: [DONE]\n\n");
      };
      if (name.startsWith("branch")) held.set(name, finish);
      else finish();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(async () => {
      for (const finish of held.values()) finish();
      for (const session of sessions) {
        await session.abort();
        session.dispose();
      }
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    });
    const runtimeObjects = [],
      loaders = [];
    for (let n = 0; n < 3; n++) {
      const cwd = join(dir, String(n));
      mkdirSync(cwd);
      const modelsPath = join(cwd, "models.json");
      writeFileSync(
        modelsPath,
        JSON.stringify({
          providers: {
            fixture: {
              baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
              api: "openai-completions",
              apiKey: "synthetic-not-a-secret",
              models: [
                {
                  id: "synthetic",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 32768,
                  maxTokens: 128,
                },
              ],
            },
          },
        }),
      );
      const runtime = await sdk.ModelRuntime.create({
        authPath: join(cwd, "auth.json"),
        modelsPath,
        modelsStorePath: join(cwd, "model-store.json"),
        allowModelNetwork: false,
      });
      runtimeObjects.push(runtime);
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
        extensionFactories: [
          {
            name: `isolated-${n}`,
            factory: (pi) => {
              pi.on("session_start", () =>
                pi.appendEntry("isolation", { owner: n }),
              );
            },
          },
        ],
      });
      await loader.reload();
      loaders.push(loader);
      const { session } = await sdk.createAgentSession({
        cwd,
        agentDir: cwd,
        modelRuntime: runtime,
        model: runtime.getModel("fixture", "synthetic"),
        resourceLoader: loader,
        settingsManager,
        sessionManager: sdk.SessionManager.create(cwd, join(cwd, "sessions")),
        noTools: "all",
      });
      sessions.push(session);
      await session.bindExtensions({ mode: "print" });
    }
    assert.equal(new Set(runtimeObjects).size, 3);
    assert.equal(new Set(loaders).size, 3);
    assert.equal(new Set(sessions.map((s) => s.sessionId)).size, 3);
    assert.equal(new Set(sessions.map((s) => s.sessionFile)).size, 3);
    for (let iteration = 0; iteration < 100; iteration++) {
      held.clear();
      const a = sessions[1].prompt("branch-a"),
        b = sessions[2].prompt("branch-b");
      await until(() => held.size === 2);
      assert.equal(sessions[1].isStreaming, true);
      assert.equal(sessions[2].isStreaming, true);
      await sessions[0].prompt(`foreground-${iteration}`);
      const fg = sessions[0].messages.at(-1);
      assert.equal(fg.role, "assistant");
      assert.equal(fg.stopReason, "stop");
      assert.match(JSON.stringify(fg.content), /complete-foreground/);
      assert.equal(sessions[1].isStreaming, true);
      assert.equal(sessions[2].isStreaming, true);
      await sessions[1].abort();
      await a;
      if (iteration === 99) sessions[1].dispose();
      assert.equal(sessions[2].isStreaming, true);
      held.get("branch-b")();
      await b;
    }
    await sessions[0].prompt("foreground-after-peer-disposal");
    assert.equal(received.length, 301);
    for (let n = 0; n < sessions.length; n++) {
      const entries = sessions[n].sessionManager
        .getEntries()
        .filter((e) => e.customType === "isolation");
      assert.deepEqual(
        entries.map((e) => e.data),
        [{ owner: n }],
      );
    }
  },
);
