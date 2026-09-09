// Tests the compiled package, not a reimplementation. No network/model/TUI required.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = pathToFileURL(`${process.argv[2]}/`).href;
const { ExtensionRunner } = await import(`${root}dist/core/extensions/runner.js`);
const { createExtensionRuntime, loadExtensionFromFactory } = await import(`${root}dist/core/extensions/loader.js`);
const { createEventBus } = await import(`${root}dist/core/event-bus.js`);
const { AgentSession } = await import(`${root}dist/core/agent-session.js`);

async function fixture() {
  const runtime = createExtensionRuntime();
  let pi;
  const extensions = [];
  extensions.push(await loadExtensionFromFactory(api => { pi = api; }, process.cwd(), createEventBus(), runtime));
  await assert.rejects(pi.invokeCommand('missing'), /not initialized/);
  const runner = new ExtensionRunner(extensions, runtime, process.cwd(), {}, {});
  const session = {
    _extensionRunner: runner,
    promptTemplates: [{ name: 'template' }],
    _resourceLoader: { getSkills: () => ({ skills: [{ name: 'test' }] }) },
    systemPrompt: 'test system prompt',
  };
  // Use the real session getCommands binding, with inert dependencies.
  AgentSession.prototype._bindExtensionCore.call(session, runner);
  return { pi, runtime, runner, session, extensions };
}
const { pi, runner, session, extensions, runtime } = await fixture();
let received;
pi.registerCommand('hello', { handler: async (args, ctx) => {
  received = [args, ctx];
  assert.equal(ctx.getSystemPrompt(), 'test system prompt');
  assert.equal(typeof ctx.reload, 'function');
  assert.equal(typeof ctx.newSession, 'function');
} });
assert.equal(await pi.invokeCommand('hello', '  a "b"\n '), undefined);
assert.equal(received[0], '  a "b"\n ');
await pi.invokeCommand('hello');
assert.equal(received[0], '');
for (const name of ['missing', '/hello', 'hello args', 'model', 'template', 'skill:test']) {
  await assert.rejects(pi.invokeCommand(name), /Unknown extension command/);
}
assert(!pi.getCommands().some(c => c.name === 'model'));
assert(pi.getCommands().some(c => c.source === 'prompt'));
assert(pi.getCommands().some(c => c.source === 'skill'));
let suffix;
pi.registerCommand('duplicate', { handler: async () => { suffix = 1; } });
extensions.push(await loadExtensionFromFactory(api => {
  api.registerCommand('duplicate', { handler: async () => { suffix = 2; } });
}, process.cwd(), createEventBus(), runtime, '<second>'));
assert.deepEqual(pi.getCommands().filter(c => c.name.startsWith('duplicate')).map(c => c.name), ['duplicate:1', 'duplicate:2']);
for (const n of [1, 2]) { await pi.invokeCommand(`duplicate:${n}`); assert.equal(suffix, n); }
await assert.rejects(pi.invokeCommand('duplicate'), /Unknown/);
let release, completed = false;
pi.registerCommand('async', { handler: async () => {
  await new Promise(resolve => { release = resolve; }); completed = true;
} });
let settled = false;
const pending = pi.invokeCommand('async').then(() => { settled = true; });
// Drain promise continuations without resolving the handler's explicit barrier.
await new Promise(resolve => setImmediate(resolve));
assert.equal(settled, false, 'invokeCommand must await the handler');
assert.equal(completed, false);
await assert.rejects(pi.invokeCommand('async'), /already active/);
await pi.invokeCommand('hello'); // unrelated concurrent command is allowed
release(); await pending; assert.equal(completed, true);
const boom = new Error('boom');
pi.registerCommand('throw', { handler: () => { throw boom; } });
pi.registerCommand('string', { handler: async () => { throw 'string failure'; } });
for (let i = 0; i < 2; i++) {
  await assert.rejects(pi.invokeCommand('throw'), e => e === boom);
  await assert.rejects(pi.invokeCommand('string'), { name: 'Error', message: 'string failure' });
}
pi.registerCommand('self', { handler: async () => { await Promise.resolve(); await pi.invokeCommand('self'); } });
pi.registerCommand('a', { handler: async () => pi.invokeCommand('b') });
pi.registerCommand('b', { handler: async () => pi.invokeCommand('a') });
for (const name of ['self', 'a', 'self', 'a']) await assert.rejects(pi.invokeCommand(name), /already active/);
for (let i = 0; i < 17; i++) pi.registerCommand(`depth${i}`, { handler: async () => {
  if (i < 16) await pi.invokeCommand(`depth${i + 1}`);
} });
await assert.rejects(pi.invokeCommand('depth0'), /limit \(16\)/);
await pi.invokeCommand('depth1'); // cleanup after failure
const errors = [];
runner.onError(e => errors.push(e));
await assert.rejects(pi.invokeCommand('throw'), /boom/);
assert.equal(errors.length, 0); // programmatic errors are caller-owned
const prompt = text => AgentSession.prototype._tryExecuteExtensionCommand.call(session, text);
assert.equal(await prompt('/unknown'), false);
assert.equal(await prompt('/hello  raw'), true);
assert.equal(received[0], ' raw');
assert.equal(await prompt('/throw'), true);
assert.equal(errors.length, 1);
assert.equal(errors[0].error, 'boom');
pi.registerCommand('prompt-cycle', { handler: async () => { await prompt('/prompt-cycle'); } });
await pi.invokeCommand('prompt-cycle'); // prompt reports rather than propagating, as upstream
assert.match(errors.at(-1).error, /already active/);

// Exercise the actual invalidation path used by reload/session replacement. Only
// the mode's resource/session I/O is stubbed; API, runner and context are real.
for (const action of ['reload', 'newSession', 'fork', 'switchSession']) {
  const f = await fixture();
  let oldCtx, fresh;
  const replace = async () => {
    f.runner.invalidate();
    fresh = await fixture();
    return { cancelled: false };
  };
  f.runner.bindCommandContext({ waitForIdle: async () => {}, reload: replace,
    newSession: replace, fork: replace, switchSession: replace, navigateTree: async () => ({ cancelled: false }) });
  f.pi.registerCommand('replace', { handler: async (_args, ctx) => { oldCtx = ctx; await ctx[action](); } });
  const captured = f.pi.invokeCommand;
  await captured('replace'); // legitimate replacement itself must resolve
  await assert.rejects(captured('replace'), /stale/);
  await assert.rejects(f.runner.invokeCommand('replace'), /stale/);
  assert.throws(() => oldCtx.cwd, /stale/);
  assert.throws(() => oldCtx.reload(), /stale/);
  fresh.pi.registerCommand('replace', { handler: async () => {} });
  await fresh.pi.invokeCommand('replace'); // no old guard or runtime leakage
}
const inflight = await fixture();
let resume, savedCtx;
inflight.pi.registerCommand('pending', { handler: async (_args, ctx) => {
  savedCtx = ctx;
  await new Promise(resolve => { resume = resolve; });
  assert.throws(() => ctx.cwd, /stale/);
  await assert.rejects(inflight.pi.invokeCommand('pending'), /stale/);
} });
const oldPending = inflight.pi.invokeCommand('pending');
inflight.runner.invalidate();
resume(); await oldPending;
assert.throws(() => savedCtx.getSystemPrompt(), /stale/);
console.log('invokeCommand: all targeted checks passed');
