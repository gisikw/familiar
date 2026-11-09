// Exercise the compiled AgentSession manual/automatic paths without a model call.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = pathToFileURL(`${process.argv[2]}/`).href;
const { AgentSession } = await import(`${root}dist/core/agent-session.js`);
const { prepareCompaction } = await import(`${root}dist/core/compaction/compaction.js`);
const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
const entries = [
  { type: 'message', id: 'u1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Hello', timestamp: Date.now() } },
  { type: 'message', id: 'a1', parentId: 'u1', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Hello back' }], api: 'anthropic-messages', provider: 'test', model: 'test', stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
];
assert.equal(prepareCompaction(entries, settings), undefined);
const smallest = prepareCompaction(entries, { ...settings, keepRecentTokens: 0 });
assert.ok(smallest, 'safe smaller cut point exists');

function fixture(pathEntries = entries, handlers = true) {
  let calls = 0;
  let saved;
  const s = Object.create(AgentSession.prototype);
  Object.defineProperty(s, 'model', { value: { id: 'test' } });
  Object.assign(s, {
    abort: async () => {},
    settingsManager: { getCompactionSettings: () => settings },
    sessionManager: {
      getBranch: () => pathEntries,
      appendCompaction: (summary, firstKeptEntryId) => { saved = { type: 'compaction', id: 'c1', summary, firstKeptEntryId }; },
      getEntries: () => saved ? [...pathEntries, saved] : pathEntries,
      buildSessionProjection: () => ({ messages: [] }),
    },
    _extensionRunner: {
      hasHandlers: () => handlers,
      emit: async (event) => {
        if (event.type !== 'session_before_compact') return;
        calls++;
        assert.equal(event.reason, 'manual');
        assert.equal(event.preparation.settings.keepRecentTokens, 20000, 'fallback does not mutate settings');
        return { compaction: { summary: 'handoff', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
      },
    },
    _emit: () => {},
    _refreshFinalizedContext: () => {},
    _clearManualCompactionState: () => {},
    _resolveIdleWaitIfIdle: () => {},
    _emitSessionCompactFailed: async () => {},
    _runDefaultCompaction: async () => { throw new Error('unexpected model call'); },
  });
  return { s, calls: () => calls, saved: () => saved };
}
const manual = fixture();
assert.equal((await manual.s.compact()).summary, 'handoff');
assert.equal(manual.calls(), 1);
assert.ok(manual.saved());
const auto = fixture();
assert.equal(await auto.s._runAutoCompaction('threshold', false), false);
assert.equal(auto.calls(), 0);
assert.equal(await auto.s._runAutoCompaction('overflow', true), false);
assert.equal(auto.calls(), 0);
const noHandler = fixture(entries, false);
await assert.rejects(noHandler.s.compact(), /session too small/);
const empty = fixture([]);
await assert.rejects(empty.s.compact(), /session too small/);
assert.equal(empty.calls(), 0);
const already = fixture([{ type: 'compaction', id: 'c1', summary: 'done' }]);
await assert.rejects(already.s.compact(), /Already compacted/);
assert.equal(already.calls(), 0);
// A normal-sized manual compaction retains the original cut point.
const longEntries = [...entries, ...entries].map((e, i) => ({ ...structuredClone(e), id: `long${i}`, parentId: i ? `long${i - 1}` : null }));
longEntries[2].message.content = 'history '.repeat(20000);
const expected = prepareCompaction(longEntries, settings);
assert.ok(expected);
const normal = fixture(longEntries);
await normal.s.compact();
assert.equal(normal.saved().firstKeptEntryId, expected.firstKeptEntryId);
assert.equal(settings.keepRecentTokens, 20000);
console.log('manual short-session compaction: passed');
