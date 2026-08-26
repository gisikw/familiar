process.env.FAMILIAR_LOG_PATH = "/tmp/familiar-test-log";
process.env.FAMILIAR_DEBUG_LEVEL = "off";

import zip from "../integrations/pi/extensions/zip/index.ts";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

let failures = 0;
const check = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
};

const entries: any[] = [];
let id = 0;
const add = (role: string, content: string) => {
  const entry = {
    type: "message",
    id: `e${++id}`,
    parentId: entries.at(-1)?.id ?? null,
    timestamp: new Date(1700000000000 + id).toISOString(),
    message: {
      role,
      content: role === "assistant" ? [{ type: "text", text: content }] : content,
      timestamp: 1700000000000 + id,
    },
  };
  entries.push(entry);
  return entry.id;
};

const root = add("user", "start the real task");
const beforeTangent = add("assistant", "working");
const tangent = add("user", "investigate the tangent " + "x".repeat(600));
add("assistant", "many mechanical details");
// Enough indexed material to force recommendation paging under the tiny mock
// model window used below.
for (let i = 0; i < 45; i++) {
  add("user", `loop ${i} ` + "y".repeat(600));
  add("assistant", `result ${i}`);
}

const handlers: Record<string, Function[]> = {};
const tools: Record<string, any> = {};
const commands: Record<string, any> = {};
const renderers: Record<string, Function> = {};
const appended: any[] = [];
const notices: string[] = [];
const widgets: { key: string; content: unknown }[] = [];
let modelCalls = 0;
let recommendationPageCalls = 0;
let navigateCalls: any[] = [];

const ctx: any = {
  hasUI: true,
  ui: {
    notify: (message: string) => notices.push(message),
    select: async () => undefined,
    setEditorText: () => {},
    setWidget: (key: string, content: unknown) => widgets.push({ key, content }),
  },
  sessionManager: {
    getEntries: () => [...entries, ...appended.map((a, i) => ({ ...a, id: `c${i}`, parentId: entries.at(-1).id, timestamp: new Date().toISOString() }))],
    getBranch: () => entries,
    getLeafId: () => entries.at(-1)?.id ?? null,
    getSessionFile: () => "/tmp/fake session.jsonl",
  },
  modelRegistry: {
    find: () => ({ id: "cheap", provider: "mock", contextWindow: 5000, maxTokens: 4096 }),
    hasConfiguredAuth: () => true,
    complete: async (_model: any, request: any) => {
      modelCalls++;
      const prompt = request.messages[0].content[0].text;
      if (/Find reasonable points/.test(prompt)) {
        recommendationPageCalls++;
        const ids = [...prompt.matchAll(/\[(e\d+)\]/g)].map((m) => m[1]);
        const chosen = ids[0];
        return {
          stopReason: "stop",
          content: [{ type: "text", text: JSON.stringify({ candidates: chosen ? [{ id: chosen, label: `page ${recommendationPageCalls}`, rationale: "boundary on this page" }] : [] }) }],
          usage: {},
        };
      }
      if (/Choose the best distinct zip-back options|Rank these proposed zip boundaries/.test(prompt)) {
        const ids = [...prompt.matchAll(/"id":"(e\d+)"/g)].map((m) => m[1]);
        return {
          stopReason: "stop",
          content: [{ type: "text", text: JSON.stringify({ candidates: [...new Set(ids)].slice(0, 8).map((candidate) => ({ id: candidate, label: "ranked", rationale: "globally useful" })) }) }],
          usage: {},
        };
      }
      return {
        stopReason: "stop",
        content: [{ type: "text", text: "This is a concise summary of the abandoned work." }],
        usage: { input: 1, output: 1 },
      };
    },
  },
  waitForIdle: async () => {},
  navigateTree: async (targetId: string, options: any) => {
    navigateCalls.push({ targetId, options, source: "command" });
    return { cancelled: false };
  },
};
ctx[Symbol.for("familiar.zip.navigate-after-settled")] = async (targetId: string, options: any) => {
  navigateCalls.push({ targetId, options, source: "scheduled" });
  return { cancelled: false };
};

const pi: any = {
  on: (event: string, handler: Function) => (handlers[event] ??= []).push(handler),
  registerTool: (tool: any) => { tools[tool.name] = tool; },
  registerCommand: (name: string, command: any) => { commands[name] = command; },
  registerEntryRenderer: (type: string, renderer: Function) => { renderers[type] = renderer; },
  appendEntry: (customType: string, data: any) => appended.push({ type: "custom", customType, data }),
};

zip(pi);
const fire = async (event: string, payload: any) => {
  let result: any;
  for (const handler of handlers[event] ?? []) result = (await handler(payload, ctx)) ?? result;
  return result;
};
const call = async (name: string, params: any) => {
  const result = await tools[name].execute("tool", params, undefined, undefined, ctx);
  return JSON.parse(result.content[0].text);
};

await fire("session_start", {});

console.log("\nregistration");
check("registers zip tool", !!tools.zip);
check("registers mark tool", !!tools.mark);
check("registers marks tool", !!tools.marks);
check("registers /mark", !!commands.mark);
check("registers /marks", !!commands.marks);
check("registers /zip", !!commands.zip);
check("removes zip-prefixed helper tools", !tools.zip_mark && !tools.zip_recommend);
{
  let bridged = "";
  const fakeRunner: any = {
    getModel: () => undefined,
    getScopedModels: () => [],
    navigateTreeHandler: async (targetId: string) => { bridged = targetId; return { cancelled: false }; },
  };
  const realContext = (ExtensionRunner.prototype as any).createContext.call(fakeRunner);
  await realContext[Symbol.for("familiar.zip.navigate-after-settled")]("bridge-target");
  check("real ExtensionRunner receives settled-navigation bridge", bridged === "bridge-target", bridged);
}

console.log("\nmarks and command navigation");
let result = await call("mark", { name: "deep-loop" });
check("agent can set a named mark", result.ok && result.marker === "deep-loop", result);
result = await call("mark", {});
check("agent can generate a mark", result.ok && /^mark-e\d+$/.test(result.marker), result);
check("mark persists", appended.some((entry) => entry.customType === "zip-marker"));
await commands.mark.handler("command-mark", ctx);
check("/mark sets a named mark", appended.some((entry) => entry.data?.name === "command-mark"));
result = await call("marks", {});
check("marks tool lists active marks", result.ok && result.marks.some((mark: any) => mark.name === "deep-loop"), result);
await commands.marks.handler("", ctx);
check("/marks lists active marks", notices.some((notice) => /Marks:/.test(notice)), notices);

navigateCalls = [];
widgets.length = 0;
await commands.zip.handler(`#${tangent} --append exact retained state`, ctx);
check("/zip user anchor navigates to its parent", navigateCalls.length === 1 && navigateCalls[0].targetId === beforeTangent, navigateCalls);
check("/zip encodes append directive", /__FAMILIAR_ZIP_V1__/.test(navigateCalls[0].options.customInstructions));
check("/zip mounts and removes a progress loader", typeof widgets[0]?.content === "function" && widgets.at(-1)?.content === undefined, widgets);
const appendDirective = navigateCalls[0].options.customInstructions;

console.log("\nscheduled agent zip");
navigateCalls = [];
widgets.length = 0;
result = await call("zip", { anchor: `#${tangent}`, mode: "replace", content: "agent-authored replacement" });
check("tool schedules without navigating live", result.scheduled && navigateCalls.length === 0, result);
await fire("agent_settled", {});
check("scheduled zip navigates after settle", navigateCalls.length === 1 && navigateCalls[0].source === "scheduled", navigateCalls);
check("scheduled zip mounts and removes a progress loader", typeof widgets[0]?.content === "function" && widgets.at(-1)?.content === undefined, widgets);

console.log("\ncustom tree summaries");
const treePreparation = {
  targetId: root,
  oldLeafId: entries.at(-1).id,
  commonAncestorId: root,
  entriesToSummarize: entries.slice(1, 8),
  userWantsSummary: true,
};
let summary = await fire("session_before_tree", { preparation: treePreparation, signal: undefined });
const summaryText = summary?.summary?.summary ?? "";
check("manual /tree gets editorial summary", /concise summary/.test(summaryText), summaryText);
check("summary explicitly identifies archived source", /abandoned branch remains verbatim/.test(summaryText), summaryText);
check("summary includes session path", /fake session\.jsonl/.test(summaryText), summaryText);
check("summary includes exact source leaf", summaryText.includes(treePreparation.oldLeafId), summaryText);
check("summary includes jq foothold", /jq -c/.test(summaryText), summaryText);
check("summary details carry provenance", summary?.summary?.details?.source === "zip", summary?.summary?.details);

summary = await fire("session_before_tree", {
  preparation: { ...treePreparation, customInstructions: appendDirective },
  signal: undefined,
});
check("append mode carries exact retained state", /## Retained state \(verbatim\)\nexact retained state/.test(summary.summary.summary), summary.summary.summary);

const replaceDirective = navigateCalls[0].options.customInstructions;
summary = await fire("session_before_tree", {
  preparation: { ...treePreparation, customInstructions: replaceDirective },
  signal: undefined,
});
check("replace mode preserves agent content verbatim", summary.summary.summary.startsWith("agent-authored replacement"), summary.summary.summary);

console.log("\npaged recommendation");
recommendationPageCalls = 0;
result = await call("marks", { query: "the implementation loop" });
check("recommendation succeeds", result.ok && result.candidates.length >= 1, result);
check("recommendation pages oversized context", recommendationPageCalls > 1, { recommendationPageCalls, modelCalls });
check("recommendation offers multiple candidates", result.candidates.length > 1, result.candidates);
check("recommendation is advisory", /Advisory only/.test(result.note), result.note);

console.log("\nrendering");
const theme: any = { fg: (_name: string, text: string) => text };
check("marker renderer works", !!renderers["zip-marker"]({ data: appended[0].data }, {}, theme));

console.log(failures ? `\n${failures} failure(s)\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
