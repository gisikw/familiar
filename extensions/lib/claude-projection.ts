// claude-projection.ts — pure TS port of tiamat's turn/claude_jsonl.go
// (ProjectClaudeCodeJSONL + projectUserMessage/projectAssistantMessage).
//
// Lowers a pi/native transcript to Claude Code's newline-delimited JSON
// transcript shape. MUST be byte-deterministic: deterministic UUIDs,
// parentUuid chaining, and millisecond-monotonic timestamps are what let a
// fresh per-turn projection reproduce the same stable prefix bytes so
// Anthropic prompt caching hits (design §3.7). Do not "tidy" key order or
// number formatting — the Go tests (ported to claude-projection.test.ts) are
// the spec.
//
// Deliberately impure-free: reads/appends no durable session files.
import { createHash } from "node:crypto";

// ---- Types (camelCase mirror of tiamat's turn.Message / ContentBlock) -------

export interface Provenance {
  origin?: string;
  backend?: string;
  provider?: string;
  model?: string;
  providerMessageID?: string;
  providerRequestID?: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image";
  text?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown; // already-parsed JSON value (Go: json.RawMessage)
  toolResultFor?: string;
  toolOutput?: unknown; // already-parsed JSON value or string
  isError?: boolean;
  imageData?: string;
  imageMediaType?: string;
  // image-bearing tool results (e.g. Familiar's read tool / uploaded
  // screenshots): the images ride alongside any textual toolOutput and are
  // projected as inline base64 blocks inside the tool_result content array.
  toolResultImages?: { data: string; mediaType: string }[];
}

export interface Message {
  id?: string;
  parentId?: string;
  createdAt?: string;
  role: "user" | "assistant" | "system" | "tool";
  content: ContentBlock[];
  provenance?: Provenance;
  usage?: Usage;
}

export interface ProjectionOptions {
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
}

const SYNTHETIC_MODEL = "<synthetic>";
export const CONTINUATION_PROMPT =
  "<tool-result>Tool call complete. Results are above.</tool-result>";

// ---- deterministic UUID (sha256 → RFC4122 v4-shaped) ------------------------

export function uuidFromString(seed: string): string {
  const sum = createHash("sha256").update(seed, "utf8").digest();
  const id = Buffer.from(sum.subarray(0, 16));
  id[6] = (id[6] & 0x0f) | 0x40;
  id[8] = (id[8] & 0x3f) | 0x80;
  const h = id.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// sessionIdFromSeed — deterministic UUID-shaped session id (port of tiamat
// turn/service.go SessionID). Version nibble 0x50 marks it distinct from the
// row-UUID scheme (0x40). Claude --session-id / --resume require UUID shape.
export function sessionIdFromSeed(seed: string): string {
  const sum = createHash("sha256").update("tiamat.claude_code.session.v1:" + seed, "utf8").digest();
  const id = Buffer.from(sum.subarray(0, 16));
  id[6] = (id[6] & 0x0f) | 0x50;
  id[8] = (id[8] & 0x3f) | 0x80;
  const h = id.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// messagesForProjection — port of tiamat messagesForClaudeProjection: drop a
// trailing user message (it becomes the stdin prompt for the current turn).
// A trailing tool message is KEPT (its continuation prompt is the stdin line).
export function messagesForProjection(messages: Message[]): Message[] {
  if (messages.length === 0) return [];
  const last = messages[messages.length - 1];
  if (last.role === "user") return messages.slice(0, -1);
  return messages;
}

// rewriteToolNamesForProjection — port of tiamat rewriteToolNamesForClaudeProjection.
// pi tool names in assistant tool_use blocks become mcp__<server>__<name> so a
// resumed claude session sees the same names it originally emitted via the MCP
// stub. Only rewrites names present in the allowed tool set and not already
// mcp-prefixed. Pure; returns a new array.
export function rewriteToolNamesForProjection(messages: Message[], toolNames: string[], server = "pi"): Message[] {
  if (toolNames.length === 0) return messages;
  const allowed = new Set(toolNames);
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    let changed = false;
    const content = m.content.map((c) => {
      if (c.type === "tool_use" && c.toolName && !c.toolName.startsWith("mcp__") && allowed.has(c.toolName)) {
        changed = true;
        return { ...c, toolName: `mcp__${server}__${c.toolName}` };
      }
      return c;
    });
    return changed ? { ...m, content } : m;
  });
}

// claudeProjectKey — the directory name under <configDir>/projects/ where
// claude looks up <sessionId>.jsonl for --resume. VERIFIED against Claude Code
// 2.1.197 (by letting it create a session and inspecting the dir it made):
// claude replaces EVERY non-alphanumeric character with '-' (no collapsing),
// so '/home/dev/.herdr' → '-home-dev--herdr'. tiamat's Go only replaced '/'
// because its workdirs had no dots; this port matches the CLI's actual rule so
// resume works from paths containing '.', '_', etc.
export function claudeProjectKey(workDir: string): string {
  let cleaned = workDir.replace(/\\/g, "/").replace(/\/+$/, "");
  cleaned = cleaned.replace(/\/{2,}/g, "/");
  if (cleaned === "." || cleaned === "") return "-";
  return cleaned.replace(/[^a-zA-Z0-9]/g, "-");
}

// 1M-context families that take the [1m] window suffix (port of tiamat
// oneMContextFamilies + claudeCodeModelArg).
const ONE_M_FAMILIES = ["claude-sonnet-4", "claude-sonnet-4-5", "claude-opus-4", "claude-opus-4-1", "claude-opus-4-8"];

export function claudeModelArg(model: string | undefined): string | undefined {
  const m = (model ?? "").trim();
  if (m === "" || m === "claude_code") return model;
  if (m.length >= 4 && m.slice(-4).toLowerCase() === "[1m]") return model;
  const lower = m.toLowerCase();
  for (const fam of ONE_M_FAMILIES) {
    if (lower === fam || lower.startsWith(fam + "-")) return m + "[1m]";
  }
  return model;
}

function isUUID(s: string | undefined): boolean {
  if (!s || s.length !== 36) return false;
  for (let i = 0; i < s.length; i++) {
    const r = s[i];
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (r !== "-") return false;
    } else if (!/[0-9a-fA-F]/.test(r)) {
      return false;
    }
  }
  return true;
}

function sanitizeID(s: string): string {
  s = s.toLowerCase();
  let out = "";
  for (const r of s) {
    if (/[a-z0-9_-]/.test(r)) out += r;
    else out += "_";
  }
  return out;
}

function claudeRowUUID(m: Message, index: number): string {
  if (isUUID(m.id)) return (m.id as string).toLowerCase();
  const seed = m.id && m.id !== "" ? m.id : `index:${index}:${m.role}:${m.createdAt ?? ""}`;
  return uuidFromString("tiamat.claude_code.row_uuid.v1:" + seed);
}

function claudeRowUUIDPart(m: Message, index: number, partIndex: number, partCount: number): string {
  const base = claudeRowUUID(m, index);
  if (partCount <= 1) return base;
  return uuidFromString(`tiamat.claude_code.row_uuid_part.v1:${base}:${partIndex}`);
}

// ---- timestamps -------------------------------------------------------------

function claudeTimestamp(createdAt: string | undefined): string {
  if (!createdAt || createdAt === "") return "1970-01-01T00:00:00.000Z";
  if (createdAt.endsWith("Z") && !createdAt.includes(".")) {
    return createdAt.slice(0, -1) + ".000Z";
  }
  return createdAt;
}

// enforce millisecond-monotonic order, formatted "…THH:MM:SS.mmmZ"
function enforceRowTimestampOrder(rows: Row[]): void {
  let last = 0;
  for (let i = 0; i < rows.length; i++) {
    let cur = Date.parse(rows[i].timestamp);
    if (Number.isNaN(cur)) throw new Error(`parse claude code row timestamp ${rows[i].timestamp}`);
    // truncate to ms (Date.parse is already ms resolution)
    if (i > 0 && cur - last < 1) cur = last + 1;
    rows[i].timestamp = new Date(cur).toISOString().replace(/\.\d{3}Z$/, (m) => m); // ensure .mmmZ
    last = cur;
  }
}

// ---- canonical JSON (matches Go json.Marshal: sorted map keys, no HTML esc) --
// JS JSON.stringify preserves insertion order and does NOT HTML-escape, which
// matches Go's enc.SetEscapeHTML(false). For re-marshaling parsed values we
// must sort object keys to mirror Go's map marshaling.
function canonicalize(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    out[k] = canonicalize((v as Record<string, unknown>)[k]);
  }
  return out;
}

function rawContentString(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(canonicalize(v));
}

// ---- provenance-derived fields ---------------------------------------------

function claudeModel(m: Message): string {
  const p = m.provenance;
  if (p && p.provider === "anthropic" && p.model && p.model !== "claude_code") return p.model;
  return SYNTHETIC_MODEL;
}

function providerMessageID(m: Message): string {
  if (m.provenance?.providerMessageID) return m.provenance.providerMessageID;
  if (m.id) return "msg_synthetic_" + sanitizeID(m.id);
  return "msg_synthetic_missing";
}

function providerRequestID(m: Message, index: number): string {
  if (m.provenance?.providerRequestID) return m.provenance.providerRequestID;
  if (m.id) return "req_synthetic_" + sanitizeID(m.id);
  return `req_synthetic_${index + 1}`;
}

function claudeUsageFor(m: Message): Record<string, number> {
  const u: Record<string, number> = { input_tokens: 0, output_tokens: 0 };
  if (m.usage) {
    u.input_tokens = m.usage.inputTokens ?? 0;
    u.output_tokens = m.usage.outputTokens ?? 0;
    if (m.usage.cacheCreationInputTokens) u.cache_creation_input_tokens = m.usage.cacheCreationInputTokens;
    if (m.usage.cacheReadInputTokens) u.cache_read_input_tokens = m.usage.cacheReadInputTokens;
  }
  return u;
}

// ---- toolUseResult display metadata (json_helpers.go toolUseResultFor) -------

function toolUseResultFor(c: ContentBlock): unknown {
  const hasImages = Array.isArray(c.toolResultImages) && c.toolResultImages.length > 0;
  const out = c.toolOutput;
  const stdoutFallback = rawContentString(out);
  if (out && typeof out === "object" && !Array.isArray(out)) {
    const obj = out as Record<string, unknown>;
    const stdout = "stdout" in obj ? String(obj.stdout) : stdoutFallback;
    const stderr = "stderr" in obj ? String(obj.stderr) : "";
    return { stdout, stderr, interrupted: false, isImage: hasImages, noOutputExpected: false };
  }
  return { stdout: stdoutFallback, stderr: "", interrupted: false, isImage: hasImages, noOutputExpected: false };
}

// ---- message projection -----------------------------------------------------

function projectUserMessage(m: Message): { role: string; content: unknown } {
  const textOnly = m.content.length === 1 && m.content[0].type === "text";
  const blocks: unknown[] = [];
  for (const c of m.content) {
    switch (c.type) {
      case "text":
        if (textOnly) return { role: "user", content: c.text ?? "" };
        blocks.push({ type: "text", text: c.text ?? "" });
        break;
      case "tool_result": {
        const textContent = rawContentString(c.toolOutput);
        const images = Array.isArray(c.toolResultImages) ? c.toolResultImages : [];
        const block: Record<string, unknown> = {
          type: "tool_result",
          tool_use_id: c.toolResultFor ?? "",
        };
        if (images.length > 0) {
          // Array content: text (if any) THEN each image as an inline base64
          // block. Verified against Claude Code 2.1.197 — image-bearing
          // tool_result array content projects and resumes correctly.
          const arr: unknown[] = [];
          if (textContent !== "") arr.push({ type: "text", text: textContent });
          for (const im of images) {
            arr.push({ type: "image", source: { type: "base64", media_type: im.mediaType ?? "", data: im.data } });
          }
          block.content = arr;
        } else {
          block.content = textContent;
        }
        if (c.isError !== undefined) block.is_error = c.isError;
        blocks.push(block);
        break;
      }
      case "image":
        if (!c.imageData) {
          throw new Error(
            "Claude Code projection requires inline image_data; image_url-only blocks are not supported",
          );
        }
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: c.imageMediaType ?? "", data: c.imageData },
        });
        break;
      default:
        throw new Error(`content block type ${c.type} is not supported by Claude Code JSONL projection`);
    }
  }
  return { role: "user", content: blocks };
}

function splitAssistantContent(blocks: ContentBlock[]): ContentBlock[][] {
  if (blocks.length === 0) return [[]];
  return blocks.map((b) => [b]);
}

function projectAssistantMessage(m: Message, blocks: ContentBlock[]): Record<string, unknown> {
  const content: unknown[] = [];
  let stopReason = "end_turn";
  for (const c of blocks) {
    switch (c.type) {
      case "text":
        content.push({ type: "text", text: c.text ?? "" });
        break;
      case "tool_use": {
        const input = c.toolInput === undefined ? {} : c.toolInput;
        content.push({ type: "tool_use", id: c.toolUseId ?? "", name: c.toolName ?? "", input });
        stopReason = "tool_use";
        break;
      }
      default:
        throw new Error(`content block type ${c.type} is not supported by Claude Code JSONL projection`);
    }
  }
  return {
    id: providerMessageID(m),
    type: "message",
    role: "assistant",
    model: claudeModel(m),
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: claudeUsageFor(m),
  };
}

// ---- row assembly -----------------------------------------------------------

interface Row {
  parentUuid: string | null;
  isSidechain: boolean;
  isMeta?: boolean;
  userType?: string;
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch?: string;
  type: string;
  message: unknown;
  requestId?: string;
  uuid: string;
  timestamp: string;
  permissionMode?: string;
  toolUseResult?: unknown;
  sourceToolAssistantUUID?: string;
}

// Serialize a Row in tiamat's exact struct-field order with omitempty rules.
function serializeRow(r: Row): string {
  const o: Record<string, unknown> = {};
  o.parentUuid = r.parentUuid;
  o.isSidechain = r.isSidechain;
  if (r.isMeta) o.isMeta = r.isMeta;
  if (r.userType) o.userType = r.userType;
  o.cwd = r.cwd;
  o.sessionId = r.sessionId;
  o.version = r.version;
  if (r.gitBranch) o.gitBranch = r.gitBranch;
  o.type = r.type;
  o.message = r.message;
  if (r.requestId) o.requestId = r.requestId;
  o.uuid = r.uuid;
  o.timestamp = r.timestamp;
  if (r.permissionMode) o.permissionMode = r.permissionMode;
  if (r.toolUseResult !== undefined) o.toolUseResult = r.toolUseResult;
  if (r.sourceToolAssistantUUID) o.sourceToolAssistantUUID = r.sourceToolAssistantUUID;
  return JSON.stringify(o);
}

export function projectClaudeCodeJSONL(messages: Message[], opts: ProjectionOptions): string {
  if (!opts.sessionId) throw new Error("claude code projection requires session id");
  const cwd = opts.cwd || process.cwd();
  const version = opts.version || "2.1.62";
  const gitBranch = opts.gitBranch ?? "";

  const messageUUIDs = new Map<string, string>();
  const toolAssistantUUIDs = new Map<string, string>();
  const rows: Row[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const rowUUID = claudeRowUUID(m, i);

    let parent: string | null = null;
    if (m.parentId && m.parentId !== "") {
      const mapped = messageUUIDs.get(m.parentId);
      if (mapped) parent = mapped;
      else parent = uuidFromString("tiamat.claude_code.parent_uuid.v1:" + m.parentId);
    } else if (i > 0) {
      parent = rows[rows.length - 1].uuid;
    }

    const base: Row = {
      parentUuid: parent,
      isSidechain: false,
      cwd,
      sessionId: opts.sessionId,
      version,
      gitBranch,
      uuid: rowUUID,
      timestamp: claudeTimestamp(m.createdAt),
      type: "",
      message: null,
    };

    if (m.role === "assistant") {
      const parts = splitAssistantContent(m.content);
      let lastUUID = "";
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex];
        const pr: Row = { ...base };
        pr.uuid = claudeRowUUIDPart(m, i, partIndex, parts.length);
        if (partIndex > 0) pr.parentUuid = lastUUID;
        pr.message = projectAssistantMessage(m, part);
        pr.type = "assistant";
        pr.requestId = providerRequestID(m, i);
        for (const b of part) {
          if (b.type === "tool_use" && b.toolUseId) toolAssistantUUIDs.set(b.toolUseId, pr.uuid);
        }
        rows.push(pr);
        lastUUID = pr.uuid;
      }
      if (m.id) messageUUIDs.set(m.id, lastUUID);
      continue;
    }

    if (m.role === "user" || m.role === "system" || m.role === "tool") {
      base.message = projectUserMessage(m);
      base.type = "user";
      base.userType = "external";
      base.permissionMode = "default";
      if (m.role === "tool") {
        for (const b of m.content) {
          if (b.type !== "tool_result") continue;
          if (b.toolResultFor) {
            const source = toolAssistantUUIDs.get(b.toolResultFor);
            if (source) base.sourceToolAssistantUUID = source;
          }
          base.toolUseResult = toolUseResultFor(b);
          break;
        }
      }
      rows.push(base);
      if (m.id) messageUUIDs.set(m.id, base.uuid);
      continue;
    }

    throw new Error(`unsupported role for claude code projection: ${m.role}`);
  }

  enforceRowTimestampOrder(rows);
  return rows.map(serializeRow).join("\n") + (rows.length ? "\n" : "");
}

// appendToolResultResumeGuard — mirror of appendClaudeToolResultResumeGuard:
// if the projection's leaf row is a tool_result user row, append a soft meta
// leaf carrying the continuation prompt so --resume has a user turn to answer.
export function appendToolResultResumeGuard(
  projection: string,
  opts: ProjectionOptions,
): { projection: string; appended: boolean } {
  const trimmed = projection.replace(/\n+$/, "");
  if (trimmed === "") return { projection, appended: false };
  const lines = trimmed.split("\n");
  const last = JSON.parse(lines[lines.length - 1]) as Row;
  if (!rowIsToolResult(last)) return { projection, appended: false };

  const guard: Row = {
    parentUuid: last.uuid,
    isSidechain: false,
    isMeta: true,
    userType: "external",
    cwd: last.cwd || opts.cwd || process.cwd(),
    sessionId: last.sessionId || opts.sessionId,
    version: last.version || opts.version || "2.1.62",
    gitBranch: last.gitBranch || opts.gitBranch,
    type: "user",
    message: { role: "user", content: CONTINUATION_PROMPT },
    uuid: uuidFromString(
      "tiamat.claude_code.tool_result_resume_guard.v1:" + last.sessionId + ":" + last.uuid,
    ),
    timestamp: timestampAfter(last.timestamp),
  };
  const out = trimmed + "\n" + serializeRow(guard) + "\n";
  return { projection: out, appended: true };
}

function timestampAfter(ts: string): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return ts;
  return new Date(t + 1).toISOString();
}

function rowIsToolResult(row: Row): boolean {
  if (row.type !== "user" || !row.message) return false;
  const msg = row.message as { content?: unknown };
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_result");
}
