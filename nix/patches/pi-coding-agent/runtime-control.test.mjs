import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const sdk = await import(
  pathToFileURL(join(process.argv[2], "dist/index.js")).href
);
const { emitProjectTrustEvent } = await import(
  pathToFileURL(join(process.argv[2], "dist/core/extensions/runner.js")).href
);
const root = mkdtempSync(join(tmpdir(), "pi-runtime-control-"));
try {
  const sm = sdk.SessionManager.create(root, root);
  const input = [
    {
      type: "message",
      message: { role: "user", content: "exact user entry  ", timestamp: 1 },
    },
    {
      type: "custom",
      customType: "familiar.background.dispatch",
      data: { admissionId: "test" },
    },
  ];
  assert.throws(
    () => sm.commitRuntimeControl("wrong", null, input),
    /conflict/,
  );
  const ids = sm.commitRuntimeControl(sm.getSessionId(), sm.getLeafId(), input);
  assert.equal(ids.length, 2);
  assert(ids.every((id) => /^[0-9a-f]{8}$/.test(id)));
  const reopened = sdk.SessionManager.open(sm.getSessionFile());
  assert.equal(reopened.getEntries().length, 2);
  assert.equal(
    reopened.buildSessionContext().messages[0].content,
    "exact user entry  ",
  );
  assert.equal(reopened.getEntry(ids[1]).parentId, ids[0]);
  assert.equal(
    reopened.persistenceBytes,
    reopened.fileEntries.reduce(
      (bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)) + 1,
      0,
    ),
  );
  assert.throws(
    () => sm.commitRuntimeControl(sm.getSessionId(), null, input),
    /conflict/,
  );
  assert.throws(
    () =>
      sm.commitRuntimeControl(sm.getSessionId(), sm.getLeafId(), [
        { type: "message", message: { role: "assistant" } },
      ]),
    /Invalid/,
  );
  assert.throws(
    () =>
      sm.commitRuntimeControl(
        sm.getSessionId(),
        sm.getLeafId(),
        Array(3).fill(input[0]),
      ),
    /batch/,
  );
  assert.throws(
    () =>
      sm.commitRuntimeControl(sm.getSessionId(), sm.getLeafId(), [
        { type: "custom", customType: "x", data: "x".repeat(8 * 1024 * 1024) },
      ]),
    /budget/,
  );
  const merge =
    '{"type":"familiar.background.merge","packetId":"packet","summary":"bounded report"}';
  sm.commitRuntimeControl(sm.getSessionId(), sm.getLeafId(), [
    {
      type: "custom_message",
      customType: "familiar.background.merge",
      content: merge,
      display: true,
    },
  ]);
  assert.equal(
    sdk.SessionManager.open(sm.getSessionFile())
      .buildSessionContext()
      .messages.at(-1).content,
    merge,
  );
  // Fail before rename: old memory/disk remains reusable. Fail after rename:
  // memory is not published and the old writer must never append again.
  for (const point of [
    "control:written",
    "control:fsynced",
    "control:renamed",
    "control:directory-synced",
  ]) {
    const manager = sdk.SessionManager.create(root, root);
    assert.throws(
      () =>
        manager.commitRuntimeControl(
          manager.getSessionId(),
          null,
          input,
          (at) => {
            if (at === point) throw new Error("injected");
          },
        ),
      /injected/,
    );
    assert.equal(manager.getEntries().length, 0);
    if (["control:renamed", "control:directory-synced"].includes(point)) {
      assert.equal(
        sdk.SessionManager.open(manager.getSessionFile()).getEntries().length,
        2,
      );
      assert.throws(
        () => manager.appendCustomEntry("forbidden", {}),
        /quarantined/,
      );
    } else {
      manager.commitRuntimeControl(manager.getSessionId(), null, input);
    }
  }
  // Incremental accounting includes the header, survives load, admits the exact
  // boundary, and does not advance after a rejected append.
  const probe = sdk.SessionManager.create(root, root);
  const probeBefore = probe.persistenceBytes;
  probe.appendCustomEntry("sized", "x".repeat(900));
  const appendBytes = probe.persistenceBytes - probeBefore;
  const limited = sdk.SessionManager.create(root, root);
  limited.setPersistenceBudget(limited.persistenceBytes + appendBytes);
  limited.appendCustomEntry("sized", "x".repeat(900));
  assert.equal(limited.persistenceBytes, limited.persistenceBudget);
  const atBoundary = limited.persistenceBytes;
  assert.throws(
    () => limited.appendCustomEntry("over-budget", "x"),
    /budget/,
  );
  assert.equal(limited.getEntries().length, 1);
  assert.equal(limited.persistenceBytes, atBoundary);
  let api, release, entered;
  let settledRejected = false;
  const enteredPromise = () =>
    new Promise((resolve) => {
      entered = resolve;
    });
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [
      (pi) => {
        api = pi;
        pi.registerCommand("hold", {
          handler: async () => {
            entered();
            await new Promise((resolve) => {
              release = resolve;
            });
          },
        });
        pi.on("session_before_switch", async () => {
          entered();
          await new Promise((resolve) => {
            release = resolve;
          });
          return { cancel: true };
        });
        pi.on("agent_settled", () => {
          try {
            commit();
          } catch (error) {
            settledRejected = /idle owner/.test(error.message);
          }
        });
      },
    ],
  });
  await loader.reload();
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
    modelsStorePath: join(root, "models-store.json"),
    allowModelNetwork: false,
  });
  const { session } = await sdk.createAgentSession({
    cwd: root,
    agentDir: root,
    settingsManager,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.create(root, root),
    noTools: "all",
  });
  await session.bindExtensions({ mode: "print" });
  const commit = () =>
    api.commitRuntimeControl(
      session.sessionId,
      session.sessionManager.getLeafId(),
      [{ type: "custom", customType: "fence-test", data: {} }],
    );
  try {
    for (const invoke of [
      () => session.prompt("/hold"),
      () => api.invokeExtensionCommand("hold"),
    ]) {
      const waiting = enteredPromise();
      const running = invoke();
      await waiting;
      assert.throws(commit, /idle owner/);
      release();
      await running;
      commit();
    }
    const runtime = new sdk.AgentSessionRuntime(
      session,
      { cwd: root, agentDir: root },
      async () => {
        throw new Error("cancelled replacement must not create");
      },
    );
    const waiting = enteredPromise();
    const replacement = runtime.newSession();
    await waiting;
    assert.throws(commit, /idle owner/);
    release();
    assert.equal((await replacement).cancelled, true);
    commit();

    // Every public replacement entrypoint holds the owner fence from its
    // synchronous call boundary until completion, including future awaits in
    // upstream method bodies. Exercise the installed wrappers independently.
    for (const action of ["switchSession", "newSession", "fork", "importFromJsonl"]) {
      const internal = `_${action}`;
      const original = runtime[internal];
      const actionWaiting = enteredPromise();
      runtime[internal] = async () => {
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
        return { cancelled: true };
      };
      const actionRun = runtime[action]();
      await actionWaiting;
      assert.throws(commit, /idle owner/, action);
      release();
      await actionRun;
      commit();
      runtime[internal] = original;
    }

    await session._emitAgentSettled();
    assert.equal(settledRejected, true);
    assert.equal(api.isRuntimeControlAvailable(), true);

    // Synchronous entry notifications are observable, but cannot recursively
    // enter a second owner transaction before the first one returns.
    let appendReentryRejected = false;
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "entry_appended") return;
      try { commit(); } catch (error) {
        appendReentryRejected = /idle owner/.test(error.message);
      }
    });
    commit();
    unsubscribe();
    assert.equal(appendReentryRejected, true);

    // project_trust is dispatched without an ExtensionRunner instance. Its
    // shared runtime fence still rejects a captured, already-bound API.
    let projectTrustRejected = false;
    let projectTrustCommandRejected = false;
    const extensionsResult = loader.getExtensions();
    extensionsResult.extensions.push({
      path: "fence-project-trust",
      handlers: new Map([["project_trust", [async () => {
        try { commit(); } catch (error) {
          projectTrustRejected = /idle owner/.test(error.message);
        }
        try { await api.invokeExtensionCommand("hold"); } catch (error) {
          projectTrustCommandRejected = /event dispatch/.test(error.message);
        }
        return { trusted: "undecided" };
      }]]]),
    });
    await emitProjectTrustEvent(
      extensionsResult,
      { type: "project_trust", cwd: root },
      {},
    );
    assert.equal(projectTrustRejected, true);
    assert.equal(projectTrustCommandRejected, true);
    assert.equal(api.isRuntimeControlAvailable(), true);
    await session.sendCustomMessage(
      { customType: "pending", content: "queued next turn", display: false },
      { deliverAs: "nextTurn" },
    );
    assert.equal(api.isRuntimeControlAvailable(), false);
    assert.throws(commit, /idle owner/);
    const manager = session.sessionManager;
    assert.throws(
      () =>
        manager.commitRuntimeControl(
          session.sessionId,
          manager.getLeafId(),
          input,
          (point) => {
            if (point === "control:renamed") throw new Error("injected");
          },
        ),
      /injected/,
    );
    assert.equal(manager.isRuntimeControlQuarantined(), true);
    await assert.rejects(
      session.prompt("must not infer"),
      /writer quarantined/,
    );
  } finally {
    session.dispose();
  }
  assert.throws(commit, /stale|disposed|replaced/i);

  // The admitted continuation is intentionally narrower than prompt(): no new
  // user append, no prompt-preflight hooks, compaction disabled, model/auth
  // ready, exact leaf unchanged across an async auth check, and normal settled
  // semantics. No provider is called: Agent.continue is replaced locally.
  const continuationLoader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  await continuationLoader.reload();
  const continuationManager = sdk.SessionManager.create(root, root);
  continuationManager.commitRuntimeControl(
    continuationManager.getSessionId(),
    null,
    [{ type: "message", message: { role: "user", content: "admitted", timestamp: 1 } }],
  );
  const { session: continuation } = await sdk.createAgentSession({
    cwd: root,
    agentDir: root,
    settingsManager,
    modelRuntime,
    resourceLoader: continuationLoader,
    sessionManager: continuationManager,
    noTools: "all",
  });
  await continuation.bindExtensions({ mode: "print" });
  const entryCount = continuationManager.getEntries().length;
  continuation.agent.state.model = undefined;
  await assert.rejects(continuation.continueAdmittedTurn(), /No model selected/);
  const fakeModel = { provider: "test-provider", id: "test-model", contextWindow: 100000 };
  continuation.agent.state.model = fakeModel;
  continuation.settingsManager.setCompactionEnabled(true);
  await assert.rejects(continuation.continueAdmittedTurn(), /compaction disabled/);
  continuation.settingsManager.setCompactionEnabled(false);
  const originalHasHandlers = continuation.extensionRunner.hasHandlers.bind(continuation.extensionRunner);
  continuation.extensionRunner.hasHandlers = (type) => type === "input" || originalHasHandlers(type);
  await assert.rejects(continuation.continueAdmittedTurn(), /preflight handlers/);
  continuation.extensionRunner.hasHandlers = originalHasHandlers;
  continuation.modelRuntime.hasConfiguredAuth = () => false;
  continuation.modelRuntime.checkAuth = async () => undefined;
  continuation.modelRuntime.isUsingOAuth = () => false;
  await assert.rejects(continuation.continueAdmittedTurn(), /API key|api key/i);
  continuation.modelRuntime.hasConfiguredAuth = () => true;
  let continued = 0;
  let prompted = 0;
  let settled = 0;
  continuation.agent.continue = async () => { continued++; };
  continuation.agent.prompt = async () => { prompted++; };
  const originalSettled = continuation._emitAgentSettled.bind(continuation);
  continuation._emitAgentSettled = async () => { settled++; await originalSettled(); };
  await continuation.continueAdmittedTurn();
  assert.equal(continued, 1);
  assert.equal(prompted, 0);
  assert.equal(settled, 1);
  assert.equal(continuationManager.getEntries().length, entryCount);
  continuation.dispose();
  assert.equal(api.isRuntimeControlAvailable(), false);
  console.log(
    "installed runtime control: atomic no-run, exact content, command/replacement fencing, bounds, quarantine passed",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
