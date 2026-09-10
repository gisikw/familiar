import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  // This second commit runs against an already-flushed file. It must append the
  // batch in place, never read or rewrite the whole parent: the pre-commit
  // bytes remain a byte-exact prefix of the post-commit file, and the file
  // grows only by the serialized batch.
  const beforeMerge = readFileSync(sm.getSessionFile());
  sm.commitRuntimeControl(sm.getSessionId(), sm.getLeafId(), [
    {
      type: "custom_message",
      customType: "familiar.background.merge",
      content: merge,
      display: true,
    },
  ]);
  const afterMerge = readFileSync(sm.getSessionFile());
  assert.deepEqual(afterMerge.subarray(0, beforeMerge.length), beforeMerge);
  assert.ok(afterMerge.length - beforeMerge.length < 4096);
  assert.equal(
    sdk.SessionManager.open(sm.getSessionFile())
      .buildSessionContext()
      .messages.at(-1).content,
    merge,
  );

  // FIX 1 (HIGH): a torn trailing line - physical bytes with no terminating
  // newline left by a partial prior write - must be repaired before an in-place
  // append. Otherwise O_APPEND joins the batch's first record to the malformed
  // bytes and the whole line is dropped on reopen, silently losing a durable
  // commit. Cover both the resident (no-reopen) writer and the reopen path.
  {
    // Resident writer, no reopen: the durable batch must survive.
    const torn = sdk.SessionManager.create(root, root);
    const tf = torn.getSessionFile();
    torn.commitRuntimeControl(torn.getSessionId(), torn.getLeafId(), input);
    appendFileSync(tf, '{"type":"message","id":"deadbeef","parentId":null,"partial');
    torn.commitRuntimeControl(torn.getSessionId(), torn.getLeafId(), [
      { type: "custom_message", customType: "familiar.background.merge", content: "durable", display: true },
    ]);
    const reopened = sdk.SessionManager.open(tf);
    assert.equal(
      reopened.getEntries().filter((e) => e.content === "durable").length,
      1,
      "committed batch survives a torn trailing line (resident writer)",
    );
    assert.ok(!readFileSync(tf, "utf8").includes("deadbeef"), "torn suffix truncated, not joined");
  }
  {
    // Torn tail, reopen, commit a new batch, reopen again, prove it persists.
    const s = sdk.SessionManager.create(root, root);
    const f = s.getSessionFile();
    s.commitRuntimeControl(s.getSessionId(), s.getLeafId(), input);
    appendFileSync(f, '{"type":"custom","customType":"torn","data":{"x":1');
    const r1 = sdk.SessionManager.open(f);
    r1.commitRuntimeControl(r1.getSessionId(), r1.getLeafId(), [
      { type: "custom_message", customType: "familiar.background.merge", content: "persisted", display: true },
    ]);
    const r2 = sdk.SessionManager.open(f);
    assert.equal(
      r2.getEntries().filter((e) => e.content === "persisted").length,
      1,
      "committed batch persists across reopen over a torn tail",
    );
  }
  {
    // Fencing: a fault during the physical repair quarantines the writer.
    const s = sdk.SessionManager.create(root, root);
    const f = s.getSessionFile();
    s.commitRuntimeControl(s.getSessionId(), s.getLeafId(), input);
    appendFileSync(f, '{"torn":true');
    assert.throws(
      () =>
        s.commitRuntimeControl(
          s.getSessionId(),
          s.getLeafId(),
          [{ type: "custom", customType: "familiar.background.merge", data: {} }],
          (p) => {
            if (p === "control:repairing") throw new Error("injected");
          },
        ),
      /injected/,
    );
    assert.equal(s.isRuntimeControlQuarantined(), true);
  }

  // FIX 2 (HIGH): materializing a not-yet-flushed canonical file fsyncs the
  // containing directory so the new name is durable; an in-place append to an
  // existing (possibly huge) parent never pays that cost, preserving O(batch).
  {
    const seenCreate = [];
    const creator = sdk.SessionManager.create(root, root);
    creator.commitRuntimeControl(creator.getSessionId(), creator.getLeafId(), input, (p) => seenCreate.push(p));
    assert.ok(seenCreate.includes("control:dir-fsynced"), "materialize fsyncs the directory");
    const seenAppend = [];
    creator.commitRuntimeControl(
      creator.getSessionId(),
      creator.getLeafId(),
      [{ type: "custom", customType: "familiar.background.merge", data: {} }],
      (p) => seenAppend.push(p),
    );
    assert.ok(!seenAppend.includes("control:dir-fsynced"), "in-place append does not re-fsync the directory");
  }

  // FIX 3 (MEDIUM): only a genuinely never-materialized session may create the
  // file. A flushed session whose archive was deleted/replaced is not silently
  // recreated merely because in-memory session/leaf IDs still match.
  {
    const fresh = sdk.SessionManager.create(root, root);
    const ff = fresh.getSessionFile();
    assert.equal(existsSync(ff), false, "never-flushed session has no file yet");
    fresh.commitRuntimeControl(fresh.getSessionId(), fresh.getLeafId(), input);
    assert.equal(existsSync(ff), true, "never-materialized path creates the file");
    rmSync(ff);
    assert.throws(
      () =>
        fresh.commitRuntimeControl(fresh.getSessionId(), fresh.getLeafId(), [
          { type: "custom", customType: "familiar.background.merge", data: {} },
        ]),
      /missing|recreate/i,
    );
    assert.equal(existsSync(ff), false, "deleted flushed archive is not silently recreated");
  }

  // FIX 4 (MEDIUM): controlWriteUncertain is cleared only after every descriptor
  // lifecycle operation succeeds. A fault in the closing phase (a proxy for a
  // closeSync failure) after mutation/publication keeps the writer quarantined
  // even though the batch is already durable.
  {
    const s = sdk.SessionManager.create(root, root);
    const f = s.getSessionFile();
    assert.throws(
      () =>
        s.commitRuntimeControl(s.getSessionId(), s.getLeafId(), input, (p) => {
          if (p === "control:closing") throw new Error("injected");
        }),
      /injected/,
    );
    assert.equal(s.isRuntimeControlQuarantined(), true, "close-phase failure quarantines the writer");
    assert.throws(() => s.appendCustomEntry("forbidden", {}), /quarantined/);
    assert.equal(
      sdk.SessionManager.open(f).getEntries().length,
      2,
      "the batch was durable before the close-phase failure",
    );
  }
  // Fail before the file is touched: the writer is reusable and re-commits.
  // Fail once the canonical file has been mutated in place: memory is never
  // published, the writer is quarantined, and the durable file already carries
  // the committed batch (a torn trailing line reopens safely).
  for (const point of [
    "control:appending",
    "control:written",
    "control:fsynced",
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
    if (point === "control:appending") {
      manager.commitRuntimeControl(manager.getSessionId(), null, input);
    } else {
      assert.equal(
        sdk.SessionManager.open(manager.getSessionFile()).getEntries().length,
        2,
      );
      assert.throws(
        () => manager.appendCustomEntry("forbidden", {}),
        /quarantined/,
      );
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
            if (point === "control:written") throw new Error("injected");
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
