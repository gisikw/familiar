// Fail closed on the lifecycle/dispatch shapes this downstream fence relies on.
// Whole-file pristine hashes are checked first; these assertions explain the contract.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(`packages/coding-agent/${p}`, 'utf8');
const session = read('src/core/agent-session.ts');
const runner = read('src/core/extensions/runner.ts');
const types = read('src/core/extensions/types.ts');
assert.match(session, /isIdle: \(\) => this\.isIdle/);
assert.match(session, /get isIdle\(\): boolean \{\s*return !this\._isAgentRunActive;/);
const prompt = session.slice(session.indexOf('async prompt('), session.indexOf('private async _tryExecuteExtensionCommand'));
assert(prompt.indexOf('await this._tryExecuteExtensionCommand(text)') >= 0);
assert(prompt.indexOf('await this._tryExecuteExtensionCommand(text)') < prompt.indexOf('if (this.isStreaming)'));
assert.match(session, /await runner\.invokeExtensionCommandFromPrompt\(commandName, args\)/);
assert.match(runner, /this\.runtime\.invokeExtensionCommand = \(name, args\) => this\.invokeExtensionCommand\(name, args\)/);
assert.match(runner, /this\.isIdleFn = contextActions\.isIdle/);
assert.match(runner, /if \(this\.isIdleFn\(\) !== true\) throw new Error/);
assert.match(runner, /if \(this\.commandActive\) throw new Error/);
assert.match(types, /invokeExtensionCommand\(name: string, args\?: string\): Promise<void>;/);
assert(!types.includes('invokeExtensionCommandFromPrompt'));
assert(!types.includes('invokeCommand('));
console.log('invokeExtensionCommand: source shape checks passed');
