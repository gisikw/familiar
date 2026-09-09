// Fail closed on the lifecycle/dispatch shapes this downstream fence relies on.
// Whole-file pristine hashes are checked first; these assertions explain the contract.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = p => readFileSync(`packages/coding-agent/${p}`, 'utf8');
const session = read('src/core/agent-session.ts');
const runner = read('src/core/extensions/runner.ts');
const types = read('src/core/extensions/types.ts');
assert.match(session, /isIdle: \(\) => this\.isIdle/);
assert.match(session, /get isIdle\(\): boolean \{\s*return !this\._isAgentRunActive;/);
assert.match(session, /async prompt\(text: string, options\?: PromptOptions\): Promise<void> \{\s*this\.controlPromptDepth\+\+;\s*try \{ return await this\._promptForOwner\(text, options\); \}\s*finally \{ this\.controlPromptDepth--; \}/);
// Background adds only a finally-safe no-run admission fence around prompt.
// Verify the entire original implementation, not a replacement hash.
const prompt = session.slice(session.indexOf('private async _promptForOwner('), session.indexOf('private async _tryExecuteExtensionCommand')).replace('private async _promptForOwner(', 'async prompt(');
assert(prompt.indexOf('await this._tryExecuteExtensionCommand(text)') >= 0);
assert(prompt.indexOf('await this._tryExecuteExtensionCommand(text)') < prompt.indexOf('if (this.isStreaming)'));
const dispatcher = session.slice(session.indexOf('private async _tryExecuteExtensionCommand'), session.indexOf('\n\t/**', session.indexOf('private async _tryExecuteExtensionCommand')));
assert.match(dispatcher, /const command = this\._extensionRunner\.getCommand\(commandName\)/);
assert.match(dispatcher, /const ctx = this\._extensionRunner\.createCommandContext\(\)/);
assert.match(dispatcher, /await command\.handler\(args, ctx\)/);
assert.match(dispatcher, /this\._extensionRunner\.emitError\(/);
assert(!dispatcher.includes('invokeExtensionCommand'));
// Pristine 0.84.1 method, including context creation and error runner selection.
assert.equal(createHash('sha256').update(dispatcher).digest('hex'),
  'cc6796c07663e960235679c3d85156d69dd9eb307bf12e4da2b1b8e63a296fec',
  'prompt dispatcher must remain byte-for-byte upstream');
assert.match(session, /runner\.bindCommandAdmission\(\(\) => this\.isIdle && this\._agentSettledDispatchDepth === 0\)/);
assert.match(session, /_agentSettledDispatchDepth\+\+;\s*this\._isAgentRunActive = false/);
assert.match(session, /finally \{\s*this\._agentSettledDispatchDepth--;\s*this\._resolveIdleWaitIfIdle\(\)/);
assert.match(runner, /this\.runtime\.invokeExtensionCommand = \(name, args\) => this\.invokeExtensionCommand\(name, args\)/);
assert.match(runner, /this\.isIdleFn = contextActions\.isIdle/);
assert.match(runner, /private commandAdmissionFn: \(\) => boolean = \(\) => false/);
assert.match(runner, /private isIdleFn: \(\) => boolean = \(\) => true/);
assert.match(runner, /if \(this\.commandAdmissionFn\(\) !== true\) throw new Error/);
assert(!runner.includes('invokeExtensionCommandFromPrompt'));
assert.match(runner, /if \(this\.commandActive\) throw new Error/);
assert.match(types, /invokeExtensionCommand\(name: string, args\?: string\): Promise<void>;/);
assert(!types.includes('invokeExtensionCommandFromPrompt'));
assert(!types.includes('invokeCommand('));
assert.equal(createHash('sha256').update(prompt).digest('hex'),
  '00211933a1265023f4346eabdd76f91d99f95bd50283f1648762a8dc9c5a4bf1');
// Exhaustive pinned runner audit. Verify both the wrapper and the unchanged body:
// only one indentation level may differ. New async methods/dispatch sites fail loudly.
const emitterHashes = {
  emit: 'f306553d899cf17270adde279d7ef9494a14166364e9ea8a176f0424e50957a2',
  emitMessageEnd: '8ab5c1a6fadd03b7e86c824062b21422be865e7bdf9d5cfab45a4980883a9845',
  emitToolResult: 'b445115005e741d95bcaa555ef85f53c85d6cfdb6865095ab4b337fa9f471446',
  emitToolCall: '433df0048a4afa205da9e3dd6a7eeb895704c85154ee716aed90bebcce6e0231',
  emitUserBash: '33390fc08f687d8d298d9bd30830eeda9c212b1f4ee5b713368e3c58de5d867e',
  emitContext: 'd2b5c0dc9cc3b38f01aab1edec00bb383d4677ce836279c774ca2f17ed621978',
  emitBeforeProviderRequest: '9d7bc80fe0c70508ea024f3cd5b10195ee08d3169e99e31de7944d5f8e11e667',
  emitBeforeProviderHeaders: 'df1d59d8865c326bbcc5cb3c72ef79930ac38a88a717e90929135ef72801520a',
  emitBeforeAgentStart: 'ff28c527a7731246f5e01f453996e216ed65144353b7952624439781bee03c28',
  emitResourcesDiscover: 'c11b8232d1ba1c33b63e35dc6bf35da1e340030c8b81dd8fb10697defef470e4',
  emitInput: '274bd320c8fbda40abf0120f6cc3ee31b10db4723c7da58e00e35c50248ff0e6',
};
const runnerClass = runner.slice(runner.indexOf('export class ExtensionRunner'));
assert.deepEqual([...runnerClass.matchAll(/\n\t(?:private |public |protected )?async (\w+)/g)].map(m => m[1]).sort(),
  ['invokeExtensionCommand', ...Object.keys(emitterHashes)].sort());
let remaining = runnerClass;
for (const [name, hash] of Object.entries(emitterHashes)) {
  const start = runner.indexOf(`\n\tasync ${name}${name === 'emit' ? '<' : '('}`);
  const method = runner.slice(start, runner.indexOf('\n\t}\n', start) + 3);
  const wrapper = method.match(/\t\tthis\.eventDispatchDepth\+\+;\n\t\ttry \{\n([\s\S]*)\n\t\t\} finally \{\n\t\t\tthis\.eventDispatchDepth--;\n\t\t\}\n\t\}$/);
  assert(wrapper, `${name}: complete finally-safe dispatch fence required`);
  assert.match(method, /> \{\n\t\tthis\.eventDispatchDepth\+\+;/);
  assert.equal(createHash('sha256').update(wrapper[1].replace(/^\t/gm, '')).digest('hex'), hash,
    `${name}: upstream dispatch behavior must remain unchanged`);
  remaining = remaining.replace(method, '');
}
assert(!remaining.includes('await handler('), 'unreviewed handler dispatch outside fenced emitters');
assert.match(runner, /private eventDispatchDepth = 0/);
assert.equal((runner.match(/this\.eventDispatchDepth\+\+/g) ?? []).length, 11);
assert.equal((runner.match(/this\.eventDispatchDepth--/g) ?? []).length, 11);
const admission = runner.slice(runner.indexOf('\n\tasync invokeExtensionCommand'), runner.indexOf('\n\t/**', runner.indexOf('\n\tasync invokeExtensionCommand')));
assert.match(admission, /if \(this\.eventDispatchDepth !== 0\) throw new Error\("Extension command unavailable during event dispatch"\)/);
assert(admission.indexOf('this.eventDispatchDepth !== 0') < admission.indexOf('this.commandActive = true'));
assert(admission.indexOf('this.eventDispatchDepth !== 0') < admission.indexOf('await '));
console.log('invokeExtensionCommand: source shape checks passed');
