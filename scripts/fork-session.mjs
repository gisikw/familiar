#!/usr/bin/env node
// Create a concurrent Pi branch and persist its provenance before it starts.
const [piRoot, source, entryId, sessionDir, parentId] = process.argv.slice(2);
if (![piRoot, source, entryId, sessionDir, parentId].every(Boolean)) {
  throw Error("usage: fork-session.mjs PI_PACKAGE_ROOT SOURCE ENTRY_ID SESSION_DIR PARENT_ID");
}
const { SessionManager } = await import(`${piRoot}/dist/core/session-manager.js`);
const manager = SessionManager.open(source, sessionDir);
const output = manager.createBranchedSession(entryId);
if (!output) throw Error("session was not persisted");
const fork = SessionManager.open(output, sessionDir);
const markerEntryId = fork.appendCustomEntry("familiar.fork.v1", { parentSessionId: parentId, branchEntryId: entryId });
fork.appendCustomMessageEntry(
  "familiar.fork-note.v1",
  `You are a fork of ${parentId}; the parent may keep going; when done, run \`imp merge "<first-person summary>"\`.`,
  true,
  { parentSessionId: parentId, branchEntryId: entryId },
);
console.log(JSON.stringify({ id: fork.getSessionId(), file: output, markerEntryId }));
