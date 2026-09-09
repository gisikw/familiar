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
const prompt = session.slice(session.indexOf('async prompt('), session.indexOf('private async _tryExecuteExtensionCommand'));
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
console.log('invokeExtensionCommand: source shape checks passed');
