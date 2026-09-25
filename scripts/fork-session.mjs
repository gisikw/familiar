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
const branchEntry = fork.getEntry(entryId);
if (branchEntry?.type === "message" && branchEntry.message?.role === "assistant") {
  for (const call of branchEntry.message.content?.filter((block) => block.type === "toolCall") ?? []) {
    const isImpFork =
      (call.name === "bash" && /(^|[;&|]\s*|\s)imp\s+fork(?:\s|$)/.test(call.arguments?.command ?? "")) ||
      (call.name === "imp" && call.arguments?.operation === "fork");
    const text = isImpFork
      ? `Forked: you are fork ${fork.getSessionId()} of ${parentId}. The parent keeps going.`
      : "Not run in this fork.";
    fork.appendMessage({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text }],
      isError: false,
      timestamp: Date.now(),
    });
  }
}
const markerEntryId = fork.appendCustomEntry("familiar.fork.v1", { parentSessionId: parentId, branchEntryId: entryId });
fork.appendCustomMessageEntry(
  "familiar.fork-note.v1",
  `You are a fork of ${parentId}; the parent may keep going. \`imp merge "<first-person summary>"\` queues your return; finish your turn, and your final words ride along.`,
  true,
  { parentSessionId: parentId, branchEntryId: entryId },
);
console.log(JSON.stringify({ id: fork.getSessionId(), file: output, markerEntryId }));
