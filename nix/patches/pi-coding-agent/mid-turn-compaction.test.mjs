// Regression guard for upstream 56700d42 (#8782 / issue #6879).
// This is a source/installed-output behavior-shape assertion: no provider call.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const installedRoot = process.argv[2];
const agentLoop = readFileSync(
  installedRoot
    ? join(installedRoot, "node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js")
    : "packages/agent/src/agent-loop.ts",
  "utf8",
);
const agentSession = readFileSync(
  installedRoot
    ? join(installedRoot, "dist/core/agent-session.js")
    : "packages/coding-agent/src/core/agent-session.ts",
  "utf8",
);

const loopStart = agentLoop.indexOf("async function runLoop(");
assert(loopStart >= 0, "agent run loop must exist");
const loop = agentLoop.slice(loopStart);
const continuation = loop.indexOf("if (lastCompletedTurn)");
const prepare = loop.indexOf("prepareNextTurn", continuation);
const provider = loop.indexOf("streamAssistantResponse", continuation);
assert(continuation >= 0 && prepare > continuation, "continued tool turns must run next-turn preparation");
assert(provider > prepare, "next-turn preparation/compaction must finish before the next assistant request");
assert.match(loop.slice(continuation, provider), /pendingMessages\.length === 0/);
assert.match(loop.slice(continuation, provider), /turn_start/);

assert.match(
  agentSession,
  /_compactBeforeNextAssistantResponse[\s\S]*shouldCompact\([\s\S]*_runAutoCompaction\(["']threshold["'], false\)/,
  "threshold compaction must be available within a continued tool-driven run",
);
const installStart = agentSession.indexOf("_installAgentNextTurnRefresh");
assert(installStart >= 0, "AgentSession must install the continuation refresh hook");
const install = agentSession.slice(installStart, agentSession.indexOf("Event Subscription", installStart));
const compact = install.indexOf("_compactBeforeNextAssistantResponse");
const previous = install.indexOf("previousPrepareNextTurnWithContext", compact);
assert(compact >= 0 && previous > compact, "compacted context must feed the pre-existing upstream next-turn hook");
assert.match(install, /model: this\.agent\.state\.model/);
assert.match(install, /thinkingLevel: this\.agent\.state\.thinkingLevel/);
console.log("upstream mid-turn compaction: preparation precedes the next assistant request and preserves effective thinking");
