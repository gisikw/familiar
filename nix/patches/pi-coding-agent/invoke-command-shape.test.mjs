// Fail closed on the lifecycle/dispatch shapes this downstream fence relies on.
// Whole-file pristine hashes are checked first; these assertions explain the contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const read = (p) => readFileSync(`packages/coding-agent/${p}`, "utf8");
const session = read("src/core/agent-session.ts");
const runner = read("src/core/extensions/runner.ts");
const types = read("src/core/extensions/types.ts");
assert.match(session, /isIdle: \(\) => this\.isIdle/);
assert.match(
  session,
  /get isIdle\(\): boolean \{\s*return !this\._isAgentRunActive && !this\.isCompacting;/,
);
// Verify the entire prompt implementation, not a replacement hash.
const prompt = session.slice(
  session.indexOf("async prompt("),
  session.indexOf("private async _tryExecuteExtensionCommand"),
);
assert(prompt.indexOf("await this._tryExecuteExtensionCommand(text)") >= 0);
assert(
  prompt.indexOf("await this._tryExecuteExtensionCommand(text)") <
    prompt.indexOf("if (this.isStreaming)"),
);
const dispatcher = session.slice(
  session.indexOf("private async _tryExecuteExtensionCommand"),
  session.indexOf(
    "\n\t/**",
    session.indexOf("private async _tryExecuteExtensionCommand"),
  ),
);
assert.match(
  dispatcher,
  /const command = this\._extensionRunner\.getCommand\(commandName\)/,
);
assert.match(
  dispatcher,
  /const ctx = this\._extensionRunner\.createCommandContext\(\)/,
);
assert.match(dispatcher, /await command\.handler\(args, ctx\)/);
assert.match(dispatcher, /this\._extensionRunner\.emitError\(/);
assert(!dispatcher.includes("invokeExtensionCommand"));
// Pristine method (unchanged from 0.85.1 through 1.0.0), including context
// creation and error runner selection.
assert.equal(
  createHash("sha256").update(dispatcher).digest("hex"),
  "cc6796c07663e960235679c3d85156d69dd9eb307bf12e4da2b1b8e63a296fec",
  "prompt dispatcher must remain byte-for-byte upstream",
);
assert.match(
  session,
  /runner\.bindCommandAdmission\(\(\) => this\.isIdle && this\._agentSettledDispatchDepth === 0\)/,
);
// Pi 0.87+ runs deferred settled actions inside _emitAgentSettled. The depth wraps
// the complete pristine upstream body (handlers, listeners, deferred runs, idle
// resolution); only one indentation level may differ.
{
  const start = session.indexOf("\n\tprivate async _emitAgentSettled(): Promise<void> {\n");
  assert(start >= 0, "_emitAgentSettled must exist");
  const method = session.slice(start, session.indexOf("\n\t}\n", start) + 3);
  const wrapper = method.match(
    /^\n\tprivate async _emitAgentSettled\(\): Promise<void> \{\n\t\tthis\._agentSettledDispatchDepth\+\+;\n\t\ttry \{\n([\s\S]*)\n\t\t\} finally \{\n\t\t\tthis\._agentSettledDispatchDepth--;\n\t\t\}\n\t\}$/,
  );
  assert(wrapper, "_emitAgentSettled: complete finally-safe settled fence required");
  const body = wrapper[1].replace(/^\t/gm, "");
  assert.equal(
    createHash("sha256").update(body).digest("hex"),
    "ad220e2271015ddf6e7720bceedda5ece79dff2a9976e6c9039037fc92ca791f",
    "_emitAgentSettled: upstream settled/deferred behavior must remain unchanged",
  );
  assert(body.indexOf("this._isAgentRunActive = false") < body.indexOf('emit({ type: "agent_settled" })'));
  assert.match(body, /this\._deferredSettledActions\.splice\(0\)/);
  assert.equal((session.match(/_agentSettledDispatchDepth\+\+/g) ?? []).length, 1);
  assert.equal((session.match(/_agentSettledDispatchDepth--/g) ?? []).length, 1);
}
assert.match(
  runner,
  /this\.runtime\.invokeExtensionCommand = \(name, args\) => this\.invokeExtensionCommand\(name, args\)/,
);
assert.match(runner, /this\.isIdleFn = contextActions\.isIdle/);
assert.match(
  runner,
  /private commandAdmissionFn: \(\) => boolean = \(\) => false/,
);
assert.match(runner, /private isIdleFn: \(\) => boolean = \(\) => true/);
assert.match(
  runner,
  /if \(this\.commandAdmissionFn\(\) !== true\) throw new Error/,
);
assert(!runner.includes("invokeExtensionCommandFromPrompt"));
assert.match(runner, /if \(this\.commandActive\) throw new Error/);
assert.match(
  types,
  /invokeExtensionCommand\(name: string, args\?: string\): Promise<void>;/,
);
assert(!types.includes("invokeExtensionCommandFromPrompt"));
assert(!types.includes("invokeCommand("));
assert.equal(
  createHash("sha256").update(prompt).digest("hex"),
  "131889da0caa28bc255886cbf633ff8b9e2b03b8bd79d4bf9825260cfbccc375",
);
// Exhaustive pinned runner audit. Verify both the wrapper and the unchanged body:
// only one indentation level may differ. New async methods/dispatch sites fail loudly.
// Pi 1.0.0 has 13: 0.87 added emitBoundary (turn_end/agent_before_settle, no longer
// routed through emit) and cache warming added emitCacheWarmingDecision.
const emitterHashes = {
  emitBoundary:
    "ee2433263493d457480213361c7f5ceaedef08026d94c10094cd4960b71c2290",
  emit: "a869ace34ce638f7c8bd8cc527778f439585a29260023d2674a70302280aab4e",
  emitCacheWarmingDecision:
    "f9b270e3b58df83a776640f689b20516800c3b19f1a5f1f2a9d7781972615a49",
  emitMessageEnd:
    "f05e7f41d067d8c14c92fac8aa5fb9d299441680b8abf9d4b9ffbc5472e1af29",
  emitToolResult:
    "603c8b36938f76d130acd4255154b07183e8aa48b5f2acba5aa15d69d46a3dea",
  emitToolCall:
    "7e7fe4f9e097f1357a4153e240dc17f1a7937ad2e0b7a11f26a6752f8657dbe8",
  emitUserBash:
    "9525e73b32bb91167b4341aa32c8bec7da6ba563f68ad69e9fb3a69a11ca7ac9",
  emitContext:
    "c068d8f2393a5fec999de055338aded7102abd1985e8ec426564434d37e83c21",
  emitBeforeProviderRequest:
    "61c1ffc801193ea20e288de10959c8413e0a468ebd1061769b5978cd1a3a59dd",
  emitBeforeProviderHeaders:
    "36e37d4a97bb09304f246f5679a797a5d7b8ab34bf9e61083dc001e234033bd6",
  emitBeforeAgentStart:
    "ee0dd76e93a2b8d405367955623b181d0e14815d6c0ed7b1e4076ef6718c2cbc",
  emitResourcesDiscover:
    "52222c54c1815ddedf0fe7de3db97adb02c1b44db6f55e1a6365f1664bbf061e",
  emitInput: "b1d2bb0cb0f50631b784af0a42590bc9d628b748ae82868ec7c1b3667472e35a",
};
const runnerClass = runner.slice(
  runner.indexOf("export class ExtensionRunner"),
);
assert.deepEqual(
  [...runnerClass.matchAll(/\n\t(?:private |public |protected )?async (\w+)/g)]
    .map((m) => m[1])
    .sort(),
  ["invokeExtensionCommand", ...Object.keys(emitterHashes)].sort(),
);
let remaining = runnerClass;
for (const [name, hash] of Object.entries(emitterHashes)) {
  const start = runner.indexOf(
    `\n\tasync ${name}${name === "emit" ? "<" : "("}`,
  );
  const method = runner.slice(start, runner.indexOf("\n\t}\n", start) + 3);
  const wrapper = method.match(
    /\t\tthis\.eventDispatchDepth\+\+;\n\t\ttry \{\n([\s\S]*)\n\t\t\} finally \{\n\t\t\tthis\.eventDispatchDepth--;\n\t\t\}\n\t\}$/,
  );
  assert(wrapper, `${name}: complete finally-safe dispatch fence required`);
  assert.match(method, /> \{\n\t\tthis\.eventDispatchDepth\+\+;/);
  assert.equal(
    createHash("sha256").update(wrapper[1].replace(/^\t/gm, "")).digest("hex"),
    hash,
    `${name}: upstream dispatch behavior must remain unchanged`,
  );
  remaining = remaining.replace(method, "");
}
assert(
  !remaining.includes("await handler("),
  "unreviewed handler dispatch outside fenced emitters",
);
assert.match(runner, /private eventDispatchDepth = 0/);
assert.equal((runner.match(/this\.eventDispatchDepth\+\+/g) ?? []).length, 13);
assert.equal((runner.match(/this\.eventDispatchDepth--/g) ?? []).length, 13);
const admission = runner.slice(
  runner.indexOf("\n\tasync invokeExtensionCommand"),
  runner.indexOf("\n\t/**", runner.indexOf("\n\tasync invokeExtensionCommand")),
);
assert.match(
  admission,
  /if \(this\.eventDispatchDepth !== 0\) throw new Error\("Extension command unavailable during event dispatch"\)/,
);
assert(
  admission.indexOf("this.eventDispatchDepth !== 0") <
    admission.indexOf("this.commandActive = true"),
);
assert(
  admission.indexOf("this.eventDispatchDepth !== 0") <
    admission.indexOf("await "),
);
console.log("invokeExtensionCommand: source shape checks passed");
