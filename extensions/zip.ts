import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  ExtensionRunner,
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { Loader, Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { errorLog } from "./lib/debug.ts";

/*
 * Zip — editorial branch compression.
 *
 * A zip is deliberately a hard cut, not an interior splice. Navigate back to
 * an anchor, summarize the branch being left, and continue from the summary.
 * Pi keeps the abandoned branch verbatim in the session tree. Anything worth
 * carrying forward belongs in the summary or an explicit verbatim addendum;
 * there is no synthetic tail and no request-time context projection.
 */

const MODEL = process.env.FAMILIAR_ZIP_MODEL || "anthropic/claude-haiku-4-5";
const ENTRY_MARKER = "zip-marker";
const ZIP_SENTINEL = "__FAMILIAR_ZIP_V1__";
const NAVIGATE_AFTER_SETTLED = Symbol.for("familiar.zip.navigate-after-settled");
const RUNNER_PATCH = Symbol.for("familiar.zip.runner-patched");
const PROGRESS_WIDGET = "zip-progress";

type ZipMode = "summarize" | "append" | "replace";

type ZipMarker = {
  name: string;
  entryId: string;
  note?: string;
  at: string;
};

type ZipRequest = {
  anchor: string;
  mode: ZipMode;
  content?: string;
  label?: string;
};

type ZipDirective = {
  mode: ZipMode;
  content?: string;
  label?: string;
};

type Candidate = {
  id: string;
  label: string;
  rationale: string;
};

type SummaryResult = {
  text: string;
  usage?: any;
  model?: string;
};

type Navigate = (
  targetId: string,
  options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
) => Promise<{ cancelled: boolean }>;

/* Pi intentionally exposes navigateTree only on command contexts because it
 * is unsafe during a live agent run. A model tool, however, needs to schedule
 * the same operation after agent_settled. Pi 0.84.1 has no public deferred
 * navigation primitive, so install a deliberately narrow bridge on the public
 * ExtensionRunner: ordinary event contexts gain one symbol-keyed action that
 * delegates to the mode's real navigation handler. We call it only from
 * agent_settled, where Pi guarantees no retry, compaction, continuation, or
 * stream remains. The real handler still owns tree events, agent-state rebuild,
 * TUI redraw, and error handling. Remove this patch when Pi grows a supported
 * schedule-after-settled command action. */
const installSettledNavigationBridge = () => {
  const proto = ExtensionRunner.prototype as any;
  if (proto[RUNNER_PATCH]) return;
  const createContext = proto.createContext;
  proto.createContext = function (...args: any[]) {
    const ctx = createContext.apply(this, args);
    Object.defineProperty(ctx, NAVIGATE_AFTER_SETTLED, {
      configurable: true,
      value: (targetId: string, options?: any) => this.navigateTreeHandler(targetId, options),
    });
    return ctx;
  };
  proto[RUNNER_PATCH] = true;
};

installSettledNavigationBridge();

const json = (obj: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  details: undefined,
  ...(isError ? { isError: true } : {}),
});

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'"'"'`)}'`;

const textOf = (message: AgentMessage): string => {
  const m = message as any;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((part: any) =>
        part?.type === "text"
          ? part.text
          : part?.type === "toolCall"
            ? `→${part.name}(${JSON.stringify(part.arguments ?? {})})`
            : "",
      )
      .filter(Boolean)
      .join(" ");
  }
  return String(m.summary ?? "");
};

const entryMessages = (entry: SessionEntry): AgentMessage[] => {
  switch (entry.type) {
    case "message":
      return [(entry as any).message];
    case "custom_message":
      return [{
        role: "custom",
        customType: (entry as any).customType,
        content: (entry as any).content,
        display: (entry as any).display,
        timestamp: new Date(entry.timestamp).getTime(),
      } as AgentMessage];
    case "compaction":
      return [{
        role: "compactionSummary",
        summary: (entry as any).summary,
        tokensBefore: (entry as any).tokensBefore,
        timestamp: new Date(entry.timestamp).getTime(),
      } as AgentMessage];
    case "branch_summary":
      return [{
        role: "branchSummary",
        summary: (entry as any).summary,
        fromId: (entry as any).fromId,
        timestamp: new Date(entry.timestamp).getTime(),
      } as AgentMessage];
    default:
      return [];
  }
};

const parseJson = (raw: string): any => {
  try {
    return JSON.parse(raw);
  } catch {
    const object = /\{[\s\S]*\}/.exec(raw)?.[0];
    const array = /\[[\s\S]*\]/.exec(raw)?.[0];
    try {
      return JSON.parse(object ?? array ?? raw);
    } catch {
      return undefined;
    }
  }
};

const directiveText = (directive: ZipDirective): string =>
  `${ZIP_SENTINEL}${JSON.stringify(directive)}`;

const parseDirective = (text?: string): ZipDirective | undefined => {
  if (!text?.startsWith(ZIP_SENTINEL)) return undefined;
  try {
    return JSON.parse(text.slice(ZIP_SENTINEL.length));
  } catch {
    return undefined;
  }
};

const addUsage = (total: any | undefined, usage: any | undefined): any | undefined => {
  if (!usage) return total;
  const out = total ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    out[key] += usage[key] ?? 0;
  }
  if (usage.cacheWrite1h != null) out.cacheWrite1h = (out.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  if (usage.reasoning != null) out.reasoning = (out.reasoning ?? 0) + usage.reasoning;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    out.cost[key] += usage.cost?.[key] ?? 0;
  }
  return out;
};

const chunkByBudget = <T>(items: T[], size: (item: T) => number, budget: number): T[][] => {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let used = 0;
  for (const item of items) {
    const n = Math.max(1, size(item));
    if (chunk.length && used + n > budget) {
      chunks.push(chunk);
      chunk = [];
      used = 0;
    }
    chunk.push(item);
    used += n;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
};

const summaryInstructions = (focus?: string) => `Write an editorial summary of an abandoned conversation branch.

This summary will replace that branch in active model context. Preserve decisions, constraints, changed file paths, unresolved questions, and the exact state needed to continue. Aggressively discard mechanical exploration, failed commands, repeated searches, and stale hypotheses. Omit empty sections; use concise markdown rather than ceremonial boilerplate. State plainly that this is a summary, not a verbatim transcript.${focus ? `\n\nAdditional focus from the caller:\n${focus}` : ""}`;

const mergeInstructions = `Merge these page summaries into one editorial branch summary. Remove duplication and page-boundary artifacts. Preserve decisions, constraints, changed file paths, unresolved questions, and the state needed to continue. Be concise, use markdown, and state plainly that this is a summary rather than a verbatim transcript.`;

const sourceBlock = (
  sessionFile: string | undefined,
  targetId: string,
  sourceLeafId: string | null,
  firstId?: string,
  lastId?: string,
): string => {
  const session = sessionFile ?? "this session's JSONL record";
  const leaf = sourceLeafId ?? lastId ?? "unknown";
  const foothold = sessionFile
    ? `jq -c --arg id ${shellQuote(leaf)} 'select(.id == $id)' ${shellQuote(sessionFile)}`
    : `locate entry ${leaf} in the session record`;
  return [
    "---",
    "**Source branch:** This is an editorial summary; the abandoned branch remains verbatim in the session archive.",
    `<zip-source session=${JSON.stringify(session)} target=${JSON.stringify(targetId)} sourceLeaf=${JSON.stringify(sourceLeafId)} first=${JSON.stringify(firstId)} last=${JSON.stringify(lastId)} />`,
    `To retrieve it, locate source leaf \`${leaf}\` and follow \`parentId\` backward to \`${targetId}\` (exclusive). Foothold: \`${foothold}\`.`,
  ].join("\n");
};

export default function zipExtension(pi: ExtensionAPI) {
  const markers = new Map<string, ZipMarker>();
  let scheduled: ZipRequest | null = null;
  let ctxRef: ExtensionContext | undefined;

  const cheapModel = (ctx: ExtensionContext): { model: any } | { error: string } => {
    const [provider, ...rest] = MODEL.split("/");
    const model = ctx.modelRegistry.find(provider, rest.join("/"));
    if (!model) return { error: `model ${MODEL} not found` };
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { error: `no configured auth for ${MODEL}` };
    return { model };
  };

  const complete = async (
    ctx: ExtensionContext,
    model: any,
    prompt: string,
    maxTokens = 4096,
    signal?: AbortSignal,
  ): Promise<{ text: string; usage?: any } | { error: string }> => {
    const response = await ctx.modelRegistry.complete(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      {
        maxTokens: Math.min(maxTokens, model.maxTokens || maxTokens),
        cacheRetention: "none",
        sessionId: uuidv7(),
        ...(signal ? { signal } : {}),
      },
    );
    if (response.stopReason === "aborted") return { error: "aborted" };
    if (response.stopReason === "error") return { error: response.errorMessage || "model call failed" };
    const text = response.content
      .filter((part: any) => part?.type === "text")
      .map((part: any) => part.text)
      .join("\n")
      .trim();
    return text ? { text, usage: response.usage } : { error: "model returned empty text" };
  };

  /* Map/reduce rather than newest-only truncation. A branch may be much larger
   * than the cheap summarizer's window; every page gets summarized, then page
   * summaries are recursively merged until one request fits. */
  const summarizeBranch = async (
    ctx: ExtensionContext,
    entries: SessionEntry[],
    focus?: string,
    signal?: AbortSignal,
  ): Promise<SummaryResult | { error: string }> => {
    const resolved = cheapModel(ctx);
    if ("error" in resolved) return resolved;
    const model = resolved.model;
    const contextWindow = Math.max(4_096, model.contextWindow || 128_000);
    const summaryOutputTokens = Math.min(2_048, Math.max(512, Math.floor(contextWindow * 0.1)));
    const budgetTokens = Math.max(1_000, Math.floor(contextWindow * 0.72) - summaryOutputTokens - 1_024);
    const budgetChars = budgetTokens * 3;
    // Keep each map result small enough that several always fit in a reduce
    // request; otherwise a tiny model could produce one over-budget summary
    // per page and make recursive merging impossible.
    const units = entries
      .map((entry) => {
        const messages = entryMessages(entry);
        if (!messages.length) return "";
        return `[entry ${entry.id}]\n${serializeConversation(convertToLlm(messages))}`;
      })
      .filter(Boolean)
      .flatMap((unit) => unit.length <= budgetChars
        ? [unit]
        : Array.from({ length: Math.ceil(unit.length / budgetChars) }, (_, i) => unit.slice(i * budgetChars, (i + 1) * budgetChars)));
    if (!units.length) return { text: "This is a summary of an abandoned branch with no substantive model-visible content." };

    const pages = chunkByBudget(units, (unit) => unit.length, budgetChars);
    let summaries: string[] = [];
    let usage: any;
    for (let i = 0; i < pages.length; i++) {
      const prompt = `<branch page="${i + 1}" pages="${pages.length}">\n${pages[i].join("\n\n")}\n</branch>\n\n${summaryInstructions(focus)}`;
      const result = await complete(ctx, model, prompt, summaryOutputTokens, signal);
      if ("error" in result) return result;
      summaries.push(result.text);
      usage = addUsage(usage, result.usage);
    }

    while (summaries.length > 1) {
      const groups = chunkByBudget(summaries, (summary) => summary.length, budgetChars);
      const merged: string[] = [];
      for (const group of groups) {
        if (group.length === 1 && groups.length > 1) {
          merged.push(group[0]);
          continue;
        }
        const prompt = `<page-summaries>\n${group.map((s, i) => `<summary n="${i + 1}">\n${s}\n</summary>`).join("\n\n")}\n</page-summaries>\n\n${mergeInstructions}`;
        const result = await complete(ctx, model, prompt, summaryOutputTokens, signal);
        if ("error" in result) return result;
        merged.push(result.text);
        usage = addUsage(usage, result.usage);
      }
      // Never silently truncate old pages. If a provider violates the output
      // cap badly enough that no two summaries fit, preserve the source branch
      // and surface a minimal failure boundary instead.
      if (merged.length >= summaries.length) {
        return { error: "paged summaries could not be merged within the summarizer context window" };
      }
      summaries = merged;
    }
    return { text: summaries[0], usage, model: model.id };
  };

  const withProgress = async <T>(ctx: ExtensionContext, run: () => Promise<T>): Promise<T> => {
    if (ctx.hasUI) {
      // setWorkingMessage only changes Pi's loader *while an agent is
      // streaming*. Scheduled zips begin after agent_end, when that row no
      // longer exists, so mount an independent loader for the navigation.
      ctx.ui.setWidget(
        PROGRESS_WIDGET,
        (tui, theme) => {
          const loader = new Loader(
            tui,
            (text) => theme.fg("accent", text),
            (text) => theme.fg("muted", text),
            "Summarizing branch…",
          );
          return Object.assign(loader, { dispose: () => loader.stop() });
        },
        { placement: "aboveEditor" },
      );
    }
    try {
      return await run();
    } finally {
      if (ctx.hasUI) ctx.ui.setWidget(PROGRESS_WIDGET, undefined);
    }
  };

  const branch = (ctx: ExtensionContext): SessionEntry[] => ctx.sessionManager.getBranch();

  const resolveAnchor = (ctx: ExtensionContext, anchor: string): { id: string; label?: string } | { error: string } => {
    const raw = anchor.trim();
    const forcedId = raw.startsWith("#");
    const key = forcedId ? raw.slice(1) : raw;
    if (!forcedId && markers.has(key)) {
      const marker = markers.get(key)!;
      if (!branch(ctx).some((entry) => entry.id === marker.entryId)) {
        return { error: `marker "${key}" is not on the active branch` };
      }
      return { id: marker.entryId, label: key };
    }
    const entry = branch(ctx).find((candidate) => candidate.id === key);
    if (!entry) {
      const names = [...markers.keys()];
      return {
        error: `unknown zip anchor "${anchor}". ${names.length ? `Marks: ${names.join(", ")}. ` : ""}Use /marks <query> or a literal #entry-id.`,
      };
    }
    // Pi treats navigation to a user message as "edit and resend": it moves
    // to the user's parent and restores that old prompt into the editor, while
    // excluding the user message itself from the abandoned-branch summary.
    // Zip anchors mean "cut beginning with this user message", so navigate to
    // its parent explicitly. This both includes the prompt in the summary and
    // leaves the editor empty after the cut.
    if (entry.type === "message" && (entry as any).message?.role === "user") {
      if (!entry.parentId) return { error: "cannot zip before the root user message; choose a later boundary" };
      return { id: entry.parentId };
    }
    return { id: entry.id };
  };

  const indexEntries = (ctx: ExtensionContext, width = 500) => branch(ctx)
    .filter((entry) => entry.type === "message" && (entry as any).message?.role === "user")
    .map((entry) => ({
      id: entry.id,
      preview: textOf((entry as any).message).replace(/\s+/g, " ").trim().slice(0, width),
    }));

  const recommend = async (ctx: ExtensionContext, subject?: string): Promise<Candidate[] | { error: string }> => {
    const resolved = cheapModel(ctx);
    if ("error" in resolved) return resolved;
    const model = resolved.model;
    const indexed = indexEntries(ctx);
    if (!indexed.length) return { error: "no user-message anchors in the active branch" };

    const markerCandidates: Candidate[] = [...markers.values()]
      .filter((marker) => branch(ctx).some((entry) => entry.id === marker.entryId))
      .map((marker) => ({ id: marker.entryId, label: marker.name, rationale: marker.note || "explicitly marked boundary" }));

    const contextWindow = Math.max(4_096, model.contextWindow || 128_000);
    const recommendOutputTokens = Math.min(1_536, Math.max(384, Math.floor(contextWindow * 0.08)));
    const budgetTokens = Math.max(1_000, Math.floor(contextWindow * 0.72) - recommendOutputTokens - 1_024);
    const budgetChars = budgetTokens * 3;
    const lines = indexed.map((entry) => `[${entry.id}] ${entry.preview}`);
    const pages = chunkByBudget(lines, (line) => line.length, budgetChars);
    const found: Candidate[] = [...markerCandidates];

    for (let i = 0; i < pages.length; i++) {
      const prompt = `Find reasonable points to zip this conversation back to${subject ? ` for the subject "${subject}"` : ""}.

A zip abandons everything beginning with the selected USER message and replaces it with an editorial summary. Return several defensible boundaries when they represent different scopes (for example: the immediate tangent, the broader implementation loop, or the whole task). Do not force a candidate when this page has no relevant boundary.

This is page ${i + 1} of ${pages.length}, in chronological order. Entry ids must be copied exactly.

<index>\n${pages[i].join("\n")}\n</index>

Return JSON only: {"candidates":[{"id":"<user entry id>","label":"<short name>","rationale":"<one sentence>"}]}`;
      const result = await complete(ctx, model, prompt, recommendOutputTokens);
      if ("error" in result) return result;
      const parsed = parseJson(result.text);
      for (const candidate of parsed?.candidates ?? []) {
        if (indexed.some((entry) => entry.id === candidate.id)) {
          found.push({ id: candidate.id, label: String(candidate.label || "candidate"), rationale: String(candidate.rationale || "") });
        }
      }
    }

    const unique = [...new Map(found.map((candidate) => [candidate.id, candidate])).values()];
    if (!unique.length) return { error: "the recommendation model found no defensible zip boundary" };

    // A second pass ranks page-local findings globally. The input is tiny
    // compared with the transcript; if it somehow is not, rank batches first.
    let pool = unique;
    while (JSON.stringify(pool).length > budgetChars) {
      const groups = chunkByBudget(pool, (candidate) => JSON.stringify(candidate).length, budgetChars);
      const reduced: Candidate[] = [];
      for (const group of groups) {
        const result = await complete(ctx, model, `Rank these proposed zip boundaries${subject ? ` for "${subject}"` : ""}. Preserve distinct useful scopes and return at most 8. JSON only: {"candidates":[...]}\n\n${JSON.stringify(group)}`, recommendOutputTokens);
        if ("error" in result) return result;
        reduced.push(...(parseJson(result.text)?.candidates ?? []));
      }
      pool = reduced;
    }

    const final = await complete(ctx, model, `Choose the best distinct zip-back options${subject ? ` for "${subject}"` : ""}. Keep multiple answers when they represent meaningfully different scopes. Rank most immediately useful first; return at most 8. Copy ids exactly. JSON only: {"candidates":[{"id":"...","label":"...","rationale":"..."}]}\n\n${JSON.stringify(pool)}`, recommendOutputTokens);
    if ("error" in final) return final;
    const ranked = (parseJson(final.text)?.candidates ?? [])
      .filter((candidate: any) => pool.some((known) => known.id === candidate.id))
      .map((candidate: any) => ({ id: candidate.id, label: String(candidate.label || "candidate"), rationale: String(candidate.rationale || "") }));
    return ranked.length ? ranked : pool.slice(0, 8);
  };

  const executeZip = async (request: ZipRequest, ctx: ExtensionCommandContext | ExtensionContext, navigate: Navigate) => {
    const resolved = resolveAnchor(ctx, request.anchor);
    if ("error" in resolved) throw new Error(resolved.error);
    if (resolved.id === ctx.sessionManager.getLeafId()) throw new Error("zip anchor is already the current leaf");
    const directive: ZipDirective = {
      mode: request.mode,
      content: request.content,
      label: request.label || resolved.label,
    };
    return navigate(resolved.id, {
      summarize: true,
      customInstructions: directiveText(directive),
      replaceInstructions: true,
      label: directive.label,
    });
  };

  const addMarker = (requestedName: string | undefined, ctx: ExtensionContext) => {
    const leaf = ctx.sessionManager.getLeafId();
    if (!leaf) throw new Error("nothing to mark yet");
    const name = requestedName?.trim() || `mark-${leaf}`;
    if (/\s/.test(name)) throw new Error("mark names cannot contain whitespace");
    const marker: ZipMarker = { name, entryId: leaf, at: new Date().toISOString() };
    markers.set(name, marker);
    pi.appendEntry<ZipMarker>(ENTRY_MARKER, marker);
    return marker;
  };

  const activeMarkers = (ctx: ExtensionContext) => {
    const ids = new Set(branch(ctx).map((entry) => entry.id));
    return [...markers.values()]
      .filter((marker) => ids.has(marker.entryId))
      .map((marker) => ({ name: marker.name, entryId: marker.entryId, note: marker.note, at: marker.at }));
  };

  /* Every tree summary — /tree as well as /zip — gets the same editorial
   * summary and exact source pointer. A zip directive adds verbatim retained
   * state or replaces generation entirely. */
  pi.on("session_before_tree", async (event, ctx) => {
    ctxRef = ctx;
    const { preparation, signal } = event;
    if (!preparation.userWantsSummary || !preparation.entriesToSummarize.length) return;

    const directive = parseDirective(preparation.customInstructions);
    const mode = directive?.mode ?? "summarize";
    const focus = directive ? undefined : preparation.customInstructions;
    let body: string;
    let usage: any;
    let model: string | undefined;

    if (mode === "replace") {
      body = directive?.content?.trim() || "This is an editorial summary of an abandoned branch; no retained content was supplied.";
    } else {
      const result = await summarizeBranch(ctx, preparation.entriesToSummarize, focus, signal);
      if ("error" in result) {
        errorLog("zip", { event: "session_before_tree", error: result.error });
        body = `This is an editorial summary boundary, but summary generation failed (${result.error}). The exact source branch remains available through the retrieval pointer below.`;
      } else {
        body = result.text;
        usage = result.usage;
        model = result.model;
      }
      if (mode === "append" && directive?.content?.trim()) {
        body += `\n\n## Retained state (verbatim)\n${directive.content.trim()}`;
      }
    }

    const first = preparation.entriesToSummarize[0]?.id;
    const last = preparation.entriesToSummarize.at(-1)?.id;
    const source = sourceBlock(
      ctx.sessionManager.getSessionFile(),
      preparation.commonAncestorId ?? preparation.targetId,
      preparation.oldLeafId,
      first,
      last,
    );
    return {
      summary: {
        summary: `${body}\n\n${source}`,
        usage,
        details: {
          source: "zip",
          mode,
          model,
          sessionFile: ctx.sessionManager.getSessionFile(),
          targetId: preparation.targetId,
          commonAncestorId: preparation.commonAncestorId,
          sourceLeafId: preparation.oldLeafId,
          firstEntryId: first,
          lastEntryId: last,
        },
      },
      label: directive?.label ?? preparation.label,
    };
  });

  pi.registerTool({
    name: "zip",
    label: "Zip Branch",
    description: "Schedule an editorial branch cut after this agent run settles. Everything after the anchor is replaced by a summary; the raw branch remains retrievable. Put exact state that must survive in content, using append (default) or replace mode.",
    promptSnippet: "Schedule a branch summary back to an earlier marker or entry",
    parameters: Type.Object({
      anchor: Type.String({ description: "A zip marker name or literal entry id (prefix # to force id)" }),
      mode: Type.Optional(Type.Union([Type.Literal("append"), Type.Literal("replace")], { description: "Append content verbatim to a generated summary, or use it as the entire summary" })),
      content: Type.Optional(Type.String({ description: "Exact retained state to append or use as replacement" })),
      label: Type.Optional(Type.String({ description: "Label for the resulting summary entry" })),
    }),
    async execute(_id, params: { anchor: string; mode?: "append" | "replace"; content?: string; label?: string }, _signal, _update, ctx) {
      ctxRef = ctx;
      const request: ZipRequest = {
        anchor: params.anchor,
        mode: params.mode ?? (params.content ? "append" : "summarize"),
        content: params.content,
        label: params.label,
      };
      if (request.mode === "replace" && !request.content?.trim()) {
        return json({ ok: false, error: "replace mode requires summary content" }, true);
      }
      const resolved = resolveAnchor(ctx, request.anchor);
      if ("error" in resolved) return json({ ok: false, error: resolved.error }, true);
      scheduled = request;
      return json({
        ok: true,
        scheduled: true,
        anchor: request.anchor,
        targetId: resolved.id,
        mode: request.mode,
        note: "The zip runs only after this agent turn fully settles. Everything after the anchor, including this tool call and the remainder of the turn, belongs to the abandoned source branch.",
      });
    },
  });

  pi.registerTool({
    name: "mark",
    label: "Mark Branch Point",
    description: "Mark the current point as a future zip anchor. A name is optional; unnamed marks receive a generated name.",
    promptSnippet: "Mark the current point as a future branch anchor",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Optional short marker name; generated when omitted" })),
    }),
    async execute(_id, params: { name?: string }, _signal, _update, ctx) {
      ctxRef = ctx;
      try {
        const marker = addMarker(params.name, ctx);
        return json({ ok: true, marker: marker.name, entryId: marker.entryId, anchor: marker.name });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  });

  pi.registerTool({
    name: "marks",
    label: "List or Recommend Marks",
    description: "List active marks, or when given a query use a cheap paged model to recommend several branch boundaries. Applies nothing.",
    promptSnippet: "List marks or recommend branch boundaries for a query",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Optional subject or loop to find; omit to list active marks" })),
    }),
    async execute(_id, params: { query?: string }, _signal, _update, ctx) {
      ctxRef = ctx;
      const query = params.query?.trim();
      if (!query) return json({ ok: true, marks: activeMarkers(ctx) });
      const result = await recommend(ctx, query);
      if ("error" in result) return json({ ok: false, error: result.error }, true);
      return json({ ok: true, candidates: result, note: "Advisory only; pass a mark name or candidate #id to zip." });
    },
  });

  pi.registerCommand("mark", {
    description: "/mark [name] — set a named mark or generate one at the current point",
    handler: async (args, ctx) => {
      ctxRef = ctx;
      try {
        const marker = addMarker(args.trim() || undefined, ctx);
        ctx.ui.notify(`Mark: ${marker.name}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("marks", {
    description: "/marks [query] — list marks or recommend branch boundaries",
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const query = args.trim();
      if (!query) {
        const found = activeMarkers(ctx);
        ctx.ui.notify(
          found.length
            ? `Marks: ${found.map((marker) => `${marker.name} (#${marker.entryId})`).join(", ")}`
            : "No active marks",
          "info",
        );
        return;
      }
      const result = await recommend(ctx, query);
      if ("error" in result) {
        ctx.ui.notify(result.error, "error");
        return;
      }
      const options = result.map((candidate) => `${candidate.label} — ${candidate.rationale} [${candidate.id}]`);
      const selected = ctx.hasUI ? await ctx.ui.select("Zip back to…", options) : undefined;
      if (selected) {
        const candidate = result[options.indexOf(selected)];
        ctx.ui.setEditorText(`/zip #${candidate.id}`);
        ctx.ui.notify("Zip command staged in the editor; add retained content or press Enter", "info");
      } else {
        ctx.ui.notify(`Candidates: ${result.map((candidate) => `${candidate.label} (#${candidate.id})`).join(", ")}`, "info");
      }
    },
  });

  pi.registerCommand("zip", {
    description: "/zip <anchor> [--append text | --replace text]",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const input = prefix.trimStart();
      if (/\s/.test(input)) return null;
      const found = ctxRef ? activeMarkers(ctxRef) : [...markers.values()];
      const items = found
        .filter((marker) => marker.name.startsWith(input))
        .map((marker) => ({
          value: marker.name,
          label: marker.name,
          description: `#${marker.entryId}`,
        }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const input = args.trim();
      if (!input) {
        ctx.ui.notify("Usage: /zip <anchor> [--append text | --replace text]", "warning");
        return;
      }

      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input)!;
      const anchor = match[1];
      let tail = (match[2] ?? "").trim();
      let mode: ZipMode = tail ? "append" : "summarize";
      if (tail.startsWith("--replace")) {
        mode = "replace";
        tail = tail.slice("--replace".length).trim();
      } else if (tail.startsWith("--append")) {
        mode = "append";
        tail = tail.slice("--append".length).trim();
      }
      if (mode === "replace" && !tail) {
        ctx.ui.notify("--replace requires summary content", "warning");
        return;
      }

      await ctx.waitForIdle();
      try {
        const result = await withProgress(ctx, () => executeZip(
          { anchor, mode, content: tail || undefined },
          ctx,
          (targetId, options) => ctx.navigateTree(targetId, options),
        ));
        if (!result.cancelled) ctx.ui.notify("Branch zipped; source remains in the session tree", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("agent_settled", async (_event, ctx) => {
    ctxRef = ctx;
    if (!scheduled) return;
    const request = scheduled;
    scheduled = null;
    const navigate = (ctx as any)[NAVIGATE_AFTER_SETTLED] as Navigate | undefined;
    if (!navigate) {
      if (ctx.hasUI) ctx.ui.notify("Scheduled zip could not access settled navigation; use /zip manually", "error");
      return;
    }
    try {
      const result = await withProgress(ctx, () => executeZip(request, ctx, navigate));
      if (!result.cancelled && ctx.hasUI) ctx.ui.notify("Scheduled branch zip complete", "info");
    } catch (error) {
      errorLog("zip", { event: "scheduled", error: error instanceof Error ? error.message : String(error) });
      if (ctx.hasUI) ctx.ui.notify(`Scheduled zip failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    scheduled = null;
    markers.clear();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY_MARKER && entry.data) {
        const marker = entry.data as ZipMarker;
        markers.set(marker.name, marker);
      }
    }
  });

  pi.registerEntryRenderer<ZipMarker>(ENTRY_MARKER, (entry, _opts, theme) => {
    const marker = entry.data;
    if (!marker) return undefined;
    const note = marker.note ? theme.fg("dim", ` — ${marker.note}`) : "";
    return new Text(`${theme.fg("accent", `⟦ zip: ${marker.name} ⟧`)}${note}`, 0, 0);
  });
}
