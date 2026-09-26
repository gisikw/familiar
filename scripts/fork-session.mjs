#!/usr/bin/env node
// Create a concurrent Pi branch and persist its provenance before it starts.
//   MODE "branch" (default): inherit the parent's conversation up to ENTRY_ID.
//   MODE "fresh": inherit only the system prompt (Pi supplies it) and the task;
//     the session starts empty but records where the parent was (ENTRY_ID).
//   MODEL "provider/model" pins the fork's model; otherwise a branch keeps the
//     parent's model and a fresh fork is pinned to the parent's current model
//     (a new session would otherwise fall back to the settings default).
const [piRoot, source, entryId, sessionDir, parentId, mode = "branch", modelArg = "", cwd = process.cwd(), role = "kes"] = process.argv.slice(2);
const runner = role === "runner";
if (![piRoot, source, entryId, sessionDir, parentId].every(Boolean) || !["branch", "fresh"].includes(mode)) {
  throw Error("usage: fork-session.mjs PI_PACKAGE_ROOT SOURCE ENTRY_ID SESSION_DIR PARENT_ID [branch|fresh] [PROVIDER/MODEL] [CWD]");
}
const { SessionManager } = await import(`${piRoot}/dist/core/session-manager.js`);
const { writeFileSync } = await import("node:fs");
const manager = SessionManager.open(source, sessionDir);

// The parent's current model and thinking level: the last changes on its branch.
const parentBranch = manager.getBranch(entryId);
const lastOf = (type) => parentBranch.findLast((e) => e.type === type);
const parentModel = lastOf("model_change");
const parentThinking = lastOf("thinking_level_change");
let model;
if (modelArg) {
  const slash = modelArg.indexOf("/");
  model = { provider: modelArg.slice(0, slash), modelId: modelArg.slice(slash + 1) };
} else if (mode === "fresh" && parentModel) {
  model = { provider: parentModel.provider, modelId: parentModel.modelId };
}

const note = (fresh) =>
  (runner
    ? `You are a lighter runner started by ${parentId} on ${modelArg}, a model we don't consider able to carry Kes. You have her prompt, but you are not her: do the task plainly and don't speak as Kes; your return will be marked as a runner's. `
    : "") +
  (fresh
    ? `You are a fresh fork of ${parentId}: you begin from your system prompt and the task below, not from the parent's conversation, so don't assume context you can't see. The parent may keep going. `
    : `You are a fork of ${parentId}; the parent may keep going. `) +
  `\`imp merge\` ends your branch; when your turn settles you'll be asked to write your return. Other forks and the parent may be editing the same files: commit only the paths you changed, never \`git commit -a\`. Edit familiar in ~/Projects/familiar (or a clone), never in /var/lib/fort-tracked/familiar/repo: the deploy tracker resets that tree. Name yourself early with \`imp label "short name"\`: a stable title for the Open list, set once (relabel only if the whole errand changes). Beneath it, \`imp status "what you're doing"\` is the line that moves: a few words, like a doorhanger, updated as your focus shifts.\n\n`;

let fork, output;
if (mode === "fresh") {
  // Pi persists a session only once an assistant message exists; write the
  // provenance entries ourselves so the unit can open a real file.
  fork = SessionManager.create(cwd, sessionDir);
  output = fork.getSessionFile();
  if (model) fork.appendModelChange(model.provider, model.modelId);
  if (parentThinking) fork.appendThinkingLevelChange(parentThinking.thinkingLevel);
} else {
  output = manager.createBranchedSession(entryId);
  if (!output) throw Error("session was not persisted");
  fork = SessionManager.open(output, sessionDir);
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
  // Only an explicit --model changes a branch's model; the prefix stays shared.
  if (modelArg) fork.appendModelChange(model.provider, model.modelId);
}
const markerEntryId = fork.appendCustomEntry("familiar.fork.v1", { parentSessionId: parentId, branchEntryId: entryId, ...(mode === "fresh" ? { fresh: true } : {}), ...(runner ? { role: "runner", model: modelArg } : {}) });
fork.appendCustomMessageEntry("familiar.fork-note.v1", note(mode === "fresh"), true, { parentSessionId: parentId, branchEntryId: entryId });
if (mode === "fresh") {
  writeFileSync(output, fork.getEntries ? [fork.getHeader(), ...fork.getEntries()].map((e) => JSON.stringify(e)).join("\n") + "\n" : "", { flag: "wx", mode: 0o600 });
}
console.log(JSON.stringify({ id: fork.getSessionId(), file: output, markerEntryId, model: model ? `${model.provider}/${model.modelId}` : "" }));
