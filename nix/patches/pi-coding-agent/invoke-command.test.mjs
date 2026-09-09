// Tests the compiled package, not a reimplementation. No network/model/TUI required.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const root = pathToFileURL(`${process.argv[2]}/`).href;
const { ExtensionRunner } = await import(
  `${root}dist/core/extensions/runner.js`
);
const { createExtensionRuntime, loadExtensionFromFactory } = await import(
  `${root}dist/core/extensions/loader.js`
);
const { createEventBus } = await import(`${root}dist/core/event-bus.js`);
const { AgentSession } = await import(`${root}dist/core/agent-session.js`);

async function fixture() {
  const runtime = createExtensionRuntime();
  let pi;
  const extensions = [];
  extensions.push(
    await loadExtensionFromFactory(
      (api) => {
        pi = api;
      },
      process.cwd(),
      createEventBus(),
      runtime,
    ),
  );
  await assert.rejects(pi.invokeExtensionCommand("missing"), /not initialized/);
  const runner = new ExtensionRunner(
    extensions,
    runtime,
    process.cwd(),
    {},
    {},
  );
  await assert.rejects(
    runner.invokeExtensionCommand("missing"),
    /requires an idle AgentSession/,
  );
  const session = Object.assign(Object.create(AgentSession.prototype), {
    _isAgentRunActive: false,
    _agentSettledDispatchDepth: 0,
    // Background's prompt wrapper reads only these additional owner fields;
    // command dispatch assertions below still exercise the installed methods.
    controlPromptDepth: 0,
    sessionManager: { isRuntimeControlQuarantined: () => false },
    _eventListeners: [],
    _extensionRunner: runner,
    _resourceLoader: {
      getPrompts: () => ({ prompts: [{ name: "template" }] }),
      getSkills: () => ({ skills: [{ name: "test" }] }),
    },
    agent: { state: { systemPrompt: "test system prompt" } },
  });
  // Use the real session getCommands binding, with inert dependencies.
  AgentSession.prototype._bindExtensionCore.call(session, runner);
  return { pi, runtime, runner, session, extensions };
}
const { pi, runner, session, extensions, runtime } = await fixture();
assert.equal(pi.invokeCommand, undefined, "no misleading legacy alias");
assert.equal(
  pi.invokeExtensionCommandFromPrompt,
  undefined,
  "no public busy bypass",
);
let received;
pi.registerCommand("hello", {
  handler: async (args, ctx) => {
    received = [args, ctx];
    assert.equal(ctx.getSystemPrompt(), "test system prompt");
    assert.equal(typeof ctx.reload, "function");
    assert.equal(typeof ctx.newSession, "function");
  },
});
assert.equal(await pi.invokeExtensionCommand("hello", '  a "b"\n '), undefined);
assert.equal(received[0], '  a "b"\n ');
await pi.invokeExtensionCommand("hello");
assert.equal(received[0], "");
for (const name of [
  "missing",
  "/hello",
  "hello args",
  "model",
  "template",
  "skill:test",
]) {
  await assert.rejects(
    pi.invokeExtensionCommand(name),
    /Unknown extension command/,
  );
}
assert(!pi.getCommands().some((c) => c.name === "model"));
assert(pi.getCommands().some((c) => c.source === "prompt"));
assert(pi.getCommands().some((c) => c.source === "skill"));
let suffix;
pi.registerCommand("duplicate", {
  handler: async () => {
    suffix = 1;
  },
});
extensions.push(
  await loadExtensionFromFactory(
    (api) => {
      api.registerCommand("duplicate", {
        handler: async () => {
          suffix = 2;
        },
      });
    },
    process.cwd(),
    createEventBus(),
    runtime,
    "<second>",
  ),
);
assert.deepEqual(
  pi
    .getCommands()
    .filter((c) => c.name.startsWith("duplicate"))
    .map((c) => c.name),
  ["duplicate:1", "duplicate:2"],
);
for (const n of [1, 2]) {
  await pi.invokeExtensionCommand(`duplicate:${n}`);
  assert.equal(suffix, n);
}
await assert.rejects(pi.invokeExtensionCommand("duplicate"), /Unknown/);
let release,
  completed = false;
pi.registerCommand("async", {
  handler: async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    completed = true;
  },
});
let settled = false;
const pending = pi.invokeExtensionCommand("async").then(() => {
  settled = true;
});
// Drain promise continuations without resolving the handler's explicit barrier.
await new Promise((resolve) => setImmediate(resolve));
assert.equal(settled, false, "invokeExtensionCommand must await the handler");
assert.equal(completed, false);
await assert.rejects(pi.invokeExtensionCommand("async"), /already active/);
await assert.rejects(pi.invokeExtensionCommand("hello"), /already active/);
release();
await pending;
assert.equal(completed, true);
const boom = new Error("boom");
pi.registerCommand("throw", {
  handler: () => {
    throw boom;
  },
});
pi.registerCommand("string", {
  handler: async () => {
    throw "string failure";
  },
});
for (let i = 0; i < 2; i++) {
  await assert.rejects(pi.invokeExtensionCommand("throw"), (e) => e === boom);
  await assert.rejects(pi.invokeExtensionCommand("string"), {
    name: "Error",
    message: "string failure",
  });
}
pi.registerCommand("self", {
  handler: async () => {
    await Promise.resolve();
    await pi.invokeExtensionCommand("self");
  },
});
pi.registerCommand("a", {
  handler: async () => pi.invokeExtensionCommand("b"),
});
let bRan = false;
pi.registerCommand("b", {
  handler: async () => {
    bRan = true;
  },
});
for (const name of ["self", "a", "self", "a"])
  await assert.rejects(pi.invokeExtensionCommand(name), /already active/);
assert.equal(bRan, false, "even A -> B must reject before B executes");
await pi.invokeExtensionCommand("b"); // cleanup after nested failures
assert.equal(bRan, true);
const errors = [];
runner.onError((e) => errors.push(e));
await assert.rejects(pi.invokeExtensionCommand("throw"), /boom/);
assert.equal(errors.length, 0); // programmatic errors are caller-owned
// Real owning-session getter and real binding: low-level streaming can be false
// during post-run event/retry/continuation work while session idle remains false.
session._isAgentRunActive = true;
session.agent.state.isStreaming = false;
await assert.rejects(
  pi.invokeExtensionCommand("hello"),
  /requires an idle AgentSession/,
);
let eventChecked = false;
pi.on("tool_call", async (_event, ctx) => {
  assert.equal(ctx.isIdle(), false);
  await assert.rejects(
    pi.invokeExtensionCommand("hello"),
    /requires an idle AgentSession/,
  );
  eventChecked = true;
});
await runner.emitToolCall({
  type: "tool_call",
  toolName: "test",
  toolCallId: "test",
  input: {},
});
assert.equal(eventChecked, true);
// Tool execute equivalent: ordinary context, awaited inside the active pipeline.
const toolExecute = async (ctx) => {
  assert.equal(ctx.isIdle(), false);
  await assert.rejects(
    pi.invokeExtensionCommand("hello"),
    /requires an idle AgentSession/,
  );
};
await toolExecute(runner.createContext());
const prompt = (text) =>
  AgentSession.prototype._tryExecuteExtensionCommand.call(session, text);
// Exercise prompt(), not only its private dispatcher. No provider/transcript path
// may be reached; no streamingBehavior is needed for a registered command.
for (const options of [undefined, { streamingBehavior: "followUp" }]) {
  let accepted;
  await session.prompt("/hello busy", {
    ...options,
    preflightResult: (v) => {
      accepted = v;
    },
  });
  assert.equal(received[0], "busy");
  assert.equal(accepted, true);
}
let busyPromptSettled = false;
const busyPrompt = session.prompt("/async").then(() => {
  busyPromptSettled = true;
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(busyPromptSettled, false, "busy prompt still awaits the command");
release();
await busyPrompt;
session._isAgentRunActive = false;
await pi.invokeExtensionCommand("hello"); // busy failure did not acquire/leak slot
assert.equal(await prompt("/unknown"), false);
assert.equal(await prompt("/hello  raw"), true);
assert.equal(received[0], " raw");
assert.equal(await prompt("/throw"), true);
assert.equal(errors.length, 1);
assert.equal(errors[0].error, "boom");
// Upstream prompt commands neither acquire nor check the new public slot.
const publicPending = pi.invokeExtensionCommand("async");
await session.prompt("/hello overlap");
assert.equal(received[0], "overlap");
await session.prompt("/throw");
assert.equal(errors.at(-1).error, "boom");
release();
await publicPending;
const promptPending = session.prompt("/async");
await pi.invokeExtensionCommand("hello", "public overlap");
assert.equal(received[0], "public overlap");
await session.prompt("/hello prompt overlap");
assert.equal(received[0], "prompt overlap");
release();
await promptPending;

// Real AgentSession settled pipeline: public isIdle stays true, admission does not.
let targetRuns = 0,
  settledChecks = 0,
  finishSettled;
pi.registerCommand("settled-target", {
  handler: async () => {
    targetRuns++;
  },
});
pi.on("agent_settled", async (_event, ctx) => {
  assert.equal(ctx.isIdle(), true);
  await assert.rejects(
    pi.invokeExtensionCommand("settled-target"),
    /requires an idle AgentSession/,
  );
  settledChecks++;
  await new Promise((resolve) => {
    finishSettled = resolve;
  });
  await assert.rejects(
    pi.invokeExtensionCommand("settled-target"),
    /requires an idle AgentSession/,
  );
});
session._isAgentRunActive = true;
const settling = session._emitAgentSettled();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(settledChecks, 1);
assert.equal(session.isIdle, true);
await assert.rejects(
  pi.invokeExtensionCommand("settled-target"),
  /requires an idle AgentSession/,
);
assert.equal(targetRuns, 0);
finishSettled();
await settling;
assert.equal(session._agentSettledDispatchDepth, 0);
await pi.invokeExtensionCommand("settled-target");
assert.equal(targetRuns, 1);
// Finally restores admission even if dispatch itself fails.
const originalEmit = runner.emit;
runner.emit = async () => {
  throw boom;
};
await assert.rejects(session._emitAgentSettled(), (e) => e === boom);
runner.emit = originalEmit;
assert.equal(session._agentSettledDispatchDepth, 0);
await pi.invokeExtensionCommand("hello");

// Every runner pipeline rejects even with a genuinely idle owning session.
// Explicit barriers prove the depth spans awaits, not just synchronous callbacks.
const eventError = {
  message: "Extension command unavailable during event dispatch",
};
const dispatchCases = [
  [
    "session_before_switch",
    (r) => r.emit({ type: "session_before_switch", reason: "switch" }),
    { cancel: true },
  ],
  [
    "session_before_fork",
    (r) => r.emit({ type: "session_before_fork", entryId: "test" }),
    { cancel: true },
  ],
  [
    "message_end",
    (r) =>
      r.emitMessageEnd({
        type: "message_end",
        message: { role: "user", content: "test" },
      }),
  ],
  ["tool_result", (r) => r.emitToolResult({ type: "tool_result" })],
  ["tool_call", (r) => r.emitToolCall({ type: "tool_call" }), { block: true }],
  [
    "user_bash",
    (r) => r.emitUserBash({ type: "user_bash" }),
    { result: { output: "test", exitCode: 0 } },
  ],
  ["context", (r) => r.emitContext([])],
  ["before_provider_request", (r) => r.emitBeforeProviderRequest({})],
  ["before_provider_headers", (r) => r.emitBeforeProviderHeaders({})],
  [
    "before_agent_start",
    (r) => r.emitBeforeAgentStart("test", undefined, "system", {}),
  ],
  [
    "resources_discover",
    (r) => r.emitResourcesDiscover(process.cwd(), "reload"),
  ],
  [
    "input",
    (r) => r.emitInput("test", undefined, "interactive"),
    { action: "handled" },
  ],
];
for (const [event, dispatch, result] of dispatchCases) {
  const f = await fixture();
  let runs = 0,
    checks = 0,
    resumeEvent;
  const emittedErrors = [];
  f.runner.onError((e) => emittedErrors.push(e));
  f.pi.registerCommand("target", {
    handler: async () => {
      runs++;
    },
  });
  f.pi.on(event, async (_event, ctx) => {
    assert.equal(ctx.isIdle(), true);
    await assert.rejects(f.pi.invokeExtensionCommand("target"), eventError);
    checks++;
    await new Promise((resolve) => {
      resumeEvent = resolve;
    });
    await assert.rejects(f.pi.invokeExtensionCommand("target"), eventError);
    checks++;
    return result;
  });
  const pendingEvent = dispatch(f.runner);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checks, 1, event);
  await assert.rejects(f.pi.invokeExtensionCommand("target"), eventError);
  assert.equal(runs, 0, event);
  resumeEvent();
  const actual = await pendingEvent;
  if (result) assert.deepEqual(actual, result);
  assert.equal(checks, 2, event);
  assert.deepEqual(emittedErrors, []);
  assert.equal(f.runner.eventDispatchDepth, 0);
  await f.pi.invokeExtensionCommand("target");
  assert.equal(runs, 1, event);
}
// Actual reload method calls the shutdown helper before invalidation. Stub only
// settings/resource rebuilding; the public slot is free throughout shutdown.
{
  const f = await fixture();
  let runs = 0,
    checked = false;
  f.pi.registerCommand("target", {
    handler: async () => {
      runs++;
    },
  });
  f.pi.on("session_shutdown", async (event, ctx) => {
    assert.equal(event.reason, "reload");
    assert.equal(ctx.isIdle(), true);
    await assert.rejects(f.pi.invokeExtensionCommand("target"), eventError);
    await Promise.resolve();
    await assert.rejects(f.pi.invokeExtensionCommand("target"), eventError);
    checked = true;
  });
  Object.assign(f.session, {
    settingsManager: { reload: async () => {} },
    syncQueueModesFromSettings: () => {},
    getActiveToolNames: () => [],
    _buildRuntime: () => {},
  });
  f.session._resourceLoader.reload = async () => {};
  await f.session.reload();
  assert.equal(checked, true);
  assert.equal(runs, 0);
  assert.equal(f.runner.eventDispatchDepth, 0);
  await assert.rejects(f.pi.invokeExtensionCommand("target"), /stale/);
}
// Nested and concurrent events must not clear each other's admission fence.
{
  const f = await fixture();
  let releaseOuter, releaseOther;
  f.pi.registerCommand("target", { handler: async () => {} });
  f.pi.on("session_start", async () => {
    await f.runner.emitInput("test", undefined, "interactive");
    await assert.rejects(f.pi.invokeExtensionCommand("target"), eventError);
    await new Promise((resolve) => {
      releaseOuter = resolve;
    });
  });
  f.pi.on("input", async () => ({ action: "handled" }));
  f.pi.on("resources_discover", async () => {
    await new Promise((resolve) => {
      releaseOther = resolve;
    });
  });
  const outer = f.runner.emit({ type: "session_start" });
  const other = f.runner.emitResourcesDiscover(".", "reload");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.runner.eventDispatchDepth, 2);
  releaseOther();
  await other;
  await assert.rejects(f.pi.invokeExtensionCommand("target"), eventError);
  releaseOuter();
  await outer;
  await f.pi.invokeExtensionCommand("target");
  f.pi.on("tool_call", async () => {
    await assert.rejects(f.pi.invokeExtensionCommand("target"), eventError);
    throw boom;
  });
  await assert.rejects(
    f.runner.emitToolCall({ type: "tool_call" }),
    (e) => e === boom,
  );
  assert.equal(f.runner.eventDispatchDepth, 0);
  await f.pi.invokeExtensionCommand("target");
  // Upstream prompt dispatch remains outside the event guard too.
  f.pi.on("session_before_tree", async () => {
    await f.session.prompt("/target");
  });
  await f.runner.emit({ type: "session_before_tree" });
}
// The synchronous session-listener tail remains fenced after runner emit returns.
{
  const f = await fixture();
  let rejected,
    runs = 0;
  f.pi.registerCommand("target", {
    handler: async () => {
      runs++;
    },
  });
  f.session._eventListeners.push(() => {
    assert.equal(f.runner.eventDispatchDepth, 0);
    rejected = assert.rejects(
      f.pi.invokeExtensionCommand("target"),
      /requires an idle AgentSession/,
    );
  });
  await f.session._emitAgentSettled();
  await rejected;
  assert.equal(runs, 0);
  await f.pi.invokeExtensionCommand("target");
}

// Exercise the actual invalidation path used by reload/session replacement. Only
// the mode's resource/session I/O is stubbed; API, runner and context are real.
for (const action of ["reload", "newSession", "fork", "switchSession"]) {
  const f = await fixture();
  let oldCtx, fresh;
  const replace = async () => {
    f.runner.invalidate();
    fresh = await fixture();
    return { cancelled: false };
  };
  f.runner.bindCommandContext({
    waitForIdle: async () => {},
    reload: replace,
    newSession: replace,
    fork: replace,
    switchSession: replace,
    navigateTree: async () => ({ cancelled: false }),
  });
  f.pi.registerCommand("replace", {
    handler: async (_args, ctx) => {
      oldCtx = ctx;
      await ctx[action]();
    },
  });
  const captured = f.pi.invokeExtensionCommand;
  await captured("replace"); // legitimate replacement itself must resolve
  await assert.rejects(captured("replace"), /stale/);
  await assert.rejects(f.runner.invokeExtensionCommand("replace"), /stale/);
  assert.throws(() => oldCtx.cwd, /stale/);
  assert.throws(() => oldCtx.reload(), /stale/);
  fresh.pi.registerCommand("replace", { handler: async () => {} });
  await fresh.pi.invokeExtensionCommand("replace"); // no old guard or runtime leakage
}
const inflight = await fixture();
let resume, savedCtx;
inflight.pi.registerCommand("pending", {
  handler: async (_args, ctx) => {
    savedCtx = ctx;
    await new Promise((resolve) => {
      resume = resolve;
    });
    assert.throws(() => ctx.cwd, /stale/);
    await assert.rejects(
      inflight.pi.invokeExtensionCommand("pending"),
      /stale/,
    );
  },
});
const oldPending = inflight.pi.invokeExtensionCommand("pending");
inflight.runner.invalidate();
resume();
await oldPending;
assert.throws(() => savedCtx.getSystemPrompt(), /stale/);
console.log("invokeExtensionCommand: all targeted checks passed");
