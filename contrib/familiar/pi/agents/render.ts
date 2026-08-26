/* ============================================================================
 * Golem agents tools — compact, expandable TUI rendering (pure logic)
 * ============================================================================
 * This module holds the PURE rendering logic for the `agents_*` tools: a
 * concise, semantic one-liner per tool state (collapsed) and the full useful
 * detail (expanded, via Ctrl+O). It has NO dependency on pi's TUI package so it
 * is fully unit-testable. The thin `new Text(...)` wrappers that pi actually
 * calls (`renderCall` / `renderResult`) live in index.ts, which is only loaded
 * under pi (where `@earendil-works/pi-tui` resolves).
 *
 * Contract (pi custom renderers):
 *   renderCall(args, theme, context)                     -> Component
 *   renderResult(result, {expanded, isPartial}, theme, context) -> Component
 *
 * Hard rules honoured here:
 *   - We NEVER truncate or alter what is delivered to the MODEL. We only choose
 *     what the operator sees in the TUI; the model always receives the complete
 *     tool-result content (the structured value / full JSON) regardless of what
 *     is rendered. Rendering reads `result.details` (the structured value) and
 *     `result.content` (the error text on failure) — it never mutates either.
 *   - Collapsed mode hides the bulky payloads: the full dispatch prompt and the
 *     artifact base64 body are reduced to a short preview / a size summary.
 *   - All colors come from pi theme tokens (theme.fg(...)); no hard-coded ANSI.
 * ========================================================================== */

/* ---- minimal structural types (no hard dependency on pi's exported types) --- */

/** The theme methods the renderers actually use. pi's `Theme` satisfies this. */
export interface AgentsTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
}

/** The subset of a tool result the renderers read. */
export interface AgentsResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

/** pi's ToolRenderOptions (what we read). */
export interface AgentsRenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
}

/** pi's ToolRenderContext (what we read). */
export interface AgentsRenderContext {
  expanded?: boolean;
  isPartial?: boolean;
  isError?: boolean;
  args?: unknown;
}

/* ---- small defensive accessors ------------------------------------------- */

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);

/** First text part of a tool result (the model-facing body / error message). */
export function firstText(result: AgentsResult): string {
  for (const c of result.content ?? []) {
    if (c && c.type === "text" && typeof c.text === "string") return c.text;
  }
  return "";
}

/**
 * Single-line preview: collapse internal whitespace and truncate to `n` chars
 * with an ellipsis. This is the "avoid dumping full prompts / large text in
 * collapsed mode" mechanism.
 */
export function preview(text: string, n = 60): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= n) return flat;
  return flat.slice(0, Math.max(0, n - 1)).trimEnd() + "…";
}

/** "project @ worktree" / "repo @ ref (worktree)" / "worktree". */
function workspaceStr(ws: unknown): string {
  const w = rec(ws);
  if (!w) return "";
  const project = str(w.project), repo = str(w.repo), ref = str(w.ref), worktree = str(w.worktree);
  if (project) return worktree ? `${project} @ ${worktree}` : project;
  if (repo) {
    const r = ref ? `${repo} @ ${ref}` : repo;
    return worktree ? `${r} (${worktree})` : r;
  }
  return worktree;
}

const TERMINAL = new Set(["done", "failed", "cancelled", "timeout"]);

/* ---- pure semantic builders (testable without a TUI) ---------------------- */

/**
 * One-line (or short multi-line when expanded) semantic summary of a Golem job.
 * Precedence: blocked-question indicator > terminal verdict > running state.
 */
export function summarizeJob(j: Record<string, unknown>, o: { expanded?: boolean } = {}): string {
  const id = str(j.id);
  const state = str(j.state) || "unknown";
  const model = str(j.model);
  const ws = workspaceStr(j.workspace);
  const q = rec(j.question);
  const settlement = rec(j.settlement);
  const exp = !!o.expanded;

  // Blocked question takes precedence — this is the actionable, operator-facing
  // state (also surfaced as a durable worklist item by the settlement relay).
  if (state === "blocked" || (q && (str(q.prompt) || str(q.text)))) {
    const prompt = preview(str(q?.prompt) || str(q?.text) || "(blocked, no prompt)", exp ? 400 : 90);
    const opts = arr(q?.options)?.map((x) => preview(String(x), 50));
    let s = `⏸ blocked`;
    if (id) s += ` · #${id}`;
    s += ` · ${prompt}`;
    if (opts && opts.length) s += ` · options: ${opts.join(" | ")}`;
    if (model) s += ` · ${model}`;
    return s;
  }

  const bits: string[] = [state];
  if (id) bits.push(`#${id}`);
  if (model) bits.push(model);
  if (ws) bits.push(ws);

  // Terminal: surface the verdict.
  if (TERMINAL.has(state)) {
    const verdict = preview(str(settlement?.verdict) || "(no verdict)", exp ? 400 : 90);
    return `${bits.join(" · ")} — ${verdict}`;
  }

  // Running / other non-terminal: state + latest progress if present.
  const progress = str(j.progress) || str(j.last_progress) || str(j.message);
  let s = bits.join(" · ");
  if (progress) s += ` — ${preview(progress, exp ? 400 : 90)}`;
  return s;
}

/**
 * capabilities: host (if present) plus counts/available harnesses/projects and
 * the clone flag. Collapsed = counts + a few harness names; expanded = the full
 * harness→models and project lists.
 */
export function summarizeCapabilities(c: Record<string, unknown>, o: { expanded?: boolean } = {}): string {
  const host = str(c.host) || str(c.daemon);
  const harnesses = rec(c.harnesses) ?? {};
  const hNames = Object.keys(harnesses);
  const projects = arr(c.projects) ?? [];
  const clone = c.clone_enabled === true;
  const head = [host, `${hNames.length} harnesses`, `${projects.length} projects`, `clones ${clone ? "on" : "off"}`]
    .filter(Boolean)
    .join(" · ");
  if (!o.expanded) {
    const show = hNames.slice(0, 4).join(", ") + (hNames.length > 4 ? ` +${hNames.length - 4}` : "");
    return show ? `${head} — ${show}` : head;
  }
  const lines: string[] = [head];
  for (const h of hNames) {
    const models = arr(rec(harnesses[h])?.models) ?? [];
    lines.push(`  • ${h}: ${models.length ? models.join(", ") : "(no models)"}`);
  }
  for (const p of projects) {
    const pr = rec(p);
    const desc = str(pr?.description);
    lines.push(`  • ${str(pr?.name)}${desc ? ` — ${desc}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * artifact list: a concise count/list. Accepts an array of {path,size}, an
 * object {artifacts:[...]}, or a single {path,size} record.
 */
export function summarizeArtifacts(arts: unknown, o: { expanded?: boolean } = {}): string {
  let list: unknown[] = [];
  const a = arr(arts);
  if (a) list = a;
  else {
    const r = rec(arts);
    const inner = arr(r?.artifacts);
    if (inner) list = inner;
    else if (r && (str(r.path) || num(r.size) !== null)) list = [r];
  }
  const n = list.length;
  if (n === 0) return "0 artifacts";
  const fmt = (x: unknown) => {
    const r = rec(x);
    const p = str(r?.path);
    const s = num(r?.size);
    return `${p || "?"}${s !== null ? ` (${s}B)` : ""}`;
  };
  if (!o.expanded) {
    const show = list.slice(0, 4).map(fmt).join(", ") + (n > 4 ? ` +${n - 4} more` : "");
    return `${n} artifacts: ${show}`;
  }
  return `${n} artifacts:\n` + list.map((x) => "  • " + fmt(x)).join("\n");
}

/**
 * artifact fetch: path + size + encoding. NEVER renders the raw base64 body —
 * it can be up to 2 MiB and is useless in the TUI. The complete base64 is still
 * in the model context (we only summarize it for the operator).
 */
export function summarizeArtifactFetch(d: Record<string, unknown>, o: { expanded?: boolean } = {}): string {
  const id = str(d.id), path = str(d.path), enc = str(d.encoding) || "base64";
  const data = str(d.data);
  const approxBytes = Math.floor((data.length * 3) / 4);
  const size = num(d.size);
  const sizeStr = size !== null ? `${size}B` : `~${approxBytes}B`;
  if (!o.expanded) {
    return `fetched ${path || "?"}${id ? ` (#${id})` : ""} · ${sizeStr} · ${enc} (body hidden)`;
  }
  return [
    `fetched ${path || "?"}${id ? ` (#${id})` : ""}`,
    `  size: ${sizeStr}`,
    `  encoding: ${enc}`,
    `  base64 body: <omitted — ${data.length} chars, full body in model context>`,
  ].join("\n");
}

/** Fallback for unknown shapes: JSON preview (collapsed) or full JSON (expanded). */
function summarizeGeneric(d: unknown, o: { expanded?: boolean } = {}): string {
  let s = "";
  try {
    s = d === undefined ? "" : JSON.stringify(d, null, o.expanded ? 2 : 0);
  } catch {
    s = String(d);
  }
  return o.expanded ? s : preview(s, 120);
}

/* ---- pure render text builders (index.ts wraps these in `new Text(...)`) -- */

function shortName(toolName: string): string {
  return toolName.replace(/^agents_/, "");
}

/**
 * Pure text for the tool-invocation header line. Collapsed shows a short
 * preview of any large text argument (prompt / answer / steer text); expanded
 * shows the full text so it stays inspectable.
 */
export function callText(toolName: string, args: unknown, theme: AgentsTheme, context: AgentsRenderContext = {}): string {
  const a = rec(args) ?? {};
  const expanded = !!context.expanded;
  const title = theme.fg("toolTitle", theme.bold(shortName(toolName) + " "));
  let rest = "";
  switch (toolName) {
    case "agents_dispatch": {
      const harness = str(a.harness), model = str(a.model);
      const ws = workspaceStr({ project: a.project, repo: a.repo, ref: a.ref, worktree: a.worktree });
      let s = "";
      if (harness || model) s += theme.fg("accent", `${harness ? harness + "/" : ""}${model || "?"}`);
      if (ws) s += " " + theme.fg("muted", "→ " + ws);
      const prompt = str(a.prompt);
      if (prompt) s += " " + theme.fg("dim", `"${expanded ? prompt : preview(prompt, 60)}"`);
      rest = s;
      break;
    }
    case "agents_status": {
      const id = str(a.id), state = str(a.state);
      rest = id ? theme.fg("muted", `#${id}`) : state ? theme.fg("muted", `state=${state}`) : theme.fg("dim", "(all)");
      break;
    }
    case "agents_answer":
    case "agents_steer": {
      const id = str(a.id), text = str(a.text);
      rest = theme.fg("muted", `#${id || "?"}`) + " " + theme.fg("dim", `"${expanded ? text : preview(text, 60)}"`);
      break;
    }
    case "agents_cancel":
    case "agents_artifacts": {
      rest = theme.fg("muted", `#${str(a.id) || "?"}`);
      break;
    }
    case "agents_artifact_fetch": {
      const id = str(a.id), path = str(a.path);
      rest = theme.fg("muted", `#${id || "?"}`) + " " + theme.fg("accent", path || "?");
      break;
    }
    case "agents_capabilities":
    default:
      rest = theme.fg("dim", "golemd capabilities");
  }
  return title + rest;
}

/** Outcome color for a non-error result (null -> default toolOutput). */
function colorFor(toolName: string, d: unknown): string | null {
  if (arr(d)) return null; // a list: neutral
  const j = rec(d);
  const state = str(j?.state);
  if (state === "blocked") return "warning";
  if (state === "done") return "success";
  if (state === "failed" || state === "timeout") return "error";
  if (state === "cancelled") return "muted";
  return null;
}

/**
 * Pure text for the tool-result output line. Handles streaming (partial),
 * failure (isError — pi sets this only when execute() THREW), and per-tool
 * semantic summaries. Collapsed is concise; expanded reveals full useful
 * detail. Never touches the model-facing content.
 */
export function resultText(toolName: string, result: AgentsResult, options: AgentsRenderOptions, theme: AgentsTheme, context: AgentsRenderContext = {}): string {
  const expanded = !!options.expanded || !!context.expanded;
  const isPartial = !!options.isPartial || !!context.isPartial;

  if (isPartial) return theme.fg("warning", "… running");

  // Failure: pi marks isError only when execute() threw; the message is the
  // thrown error text (delivered to the model as the result body).
  if (context.isError) {
    const msg = preview(firstText(result) || "error", expanded ? 400 : 120);
    return theme.fg("error", "✗ " + msg);
  }

  const d = result.details;
  let body = "";
  switch (toolName) {
    case "agents_dispatch": {
      body = rec(d) ? summarizeJob(rec(d)!, { expanded }) : summarizeGeneric(d, { expanded });
      break;
    }
    case "agents_status": {
      const list = arr(d);
      if (list) {
        if (!expanded) {
          const top = list.slice(0, 4).map((x) => summarizeJob(rec(x) ?? {}, { expanded: false }));
          body = `${list.length} jobs` + (top.length ? `:\n${top.join("\n")}${list.length > 4 ? `\n  … +${list.length - 4} more` : ""}` : "");
        } else {
          body = `${list.length} jobs:\n` + list.map((x) => "  • " + summarizeJob(rec(x) ?? {}, { expanded: true })).join("\n");
        }
      } else {
        body = rec(d) ? summarizeJob(rec(d)!, { expanded }) : summarizeGeneric(d, { expanded });
      }
      break;
    }
    case "agents_answer":
    case "agents_steer":
    case "agents_cancel": {
      const j = rec(d);
      if (j) {
        const id = str(j.id), state = str(j.state);
        body = (id ? `#${id}` : "job") + (state ? ` → ${state}` : " (ack)");
        if (expanded) {
          const extra = summarizeJob(j, { expanded: true });
          if (extra && extra !== state) body += "\n" + extra;
        }
      } else body = summarizeGeneric(d, { expanded });
      break;
    }
    case "agents_capabilities": {
      body = rec(d) ? summarizeCapabilities(rec(d)!, { expanded }) : summarizeGeneric(d, { expanded });
      break;
    }
    case "agents_artifacts": {
      body = summarizeArtifacts(d, { expanded });
      break;
    }
    case "agents_artifact_fetch": {
      body = rec(d) ? summarizeArtifactFetch(rec(d)!, { expanded }) : summarizeGeneric(d, { expanded });
      break;
    }
    default:
      body = summarizeGeneric(d, { expanded });
  }

  const color = colorFor(toolName, d);
  const [first, ...rest] = body.split("\n");
  let out = color ? theme.fg(color, first) : theme.fg("toolOutput", first);
  if (rest.length) out += "\n" + theme.fg("dim", rest.join("\n"));
  return out;
}
