/* ============================================================================
 * Golem settlement relay — background consumer/reconciler
 * ============================================================================
 *
 * Familiar's agents extension dispatches jobs to a standalone Golem daemon.
 * Golem exposes a durable, sequenced SSE feed at GET /v1/events?since=N plus
 * authoritative job detail at GET /v1/jobs/:id. This relay watches that feed
 * for the TERMINAL settlement of jobs THIS extension dispatched and routes a
 * concise worklist item through the neutral `worklist.durable-sink@1`
 * capability (WORKLIST_SINK) so the settlement respects attention policy. It
 * NEVER calls pi.sendMessage — an unavailable sink means retain-and-retry, not
 * a policy-violating direct injection.
 *
 * OWNERSHIP (anti-flood): only jobs recorded via recordDispatch() are relayed.
 * A fresh instance owns nothing, so replaying since=0 history enqueues nothing;
 * jobs from unrelated clients are never claimed. See README for the semantics.
 *
 * TWO ITEM KINDS (both flow through the same neutral sink + drop-box fallback):
 *   • TERMINAL SETTLEMENTS — a `golem-settle-<jid>` notify, relayed once the
 *     job reaches a terminal state. Exactly-once (best-effort, three layers):
 *       1. stable worklist item id → the sink dedupes on it.
 *       2. local `done/<jid>` tombstone → skip already-relayed settlements.
 *       3. `pending/<jid>` durable envelope → the retriable work item; survives
 *          restart and sink-unavailability. Cursor is an optimization only:
 *          startup + failure reconciliation over owned-unsettled jobs backstops
 *          any event missed below the persisted cursor.
 *   • BLOCKED QUESTIONS — a `golem-blocked-<jid>-<episode>` question (P0),
 *     enqueued promptly when an owned job transitions to `blocked` (SSE event,
 *     or the periodic reconcile backstop) and WITHDRAWN (sink.withdraw) when the
 *     job leaves `blocked` (answered / unblocked / went terminal). The id is
 *     stable per block-episode (keyed on the question id when the API provides
 *     one, else a content hash of the prompt) so duplicate events and restarts
 *     dedup to one item, while a re-block with a NEW question gets a NEW id and
 *     is not suppressed by the prior episode's withdraw tombstone. A
 *     `blocked/<jid>` marker records the live episode so restarts neither
 *     re-deliver nor strand it.
 *
 * LOADER ISOLATION FALLBACK: pi's extension loader can hand this external
 * contrib plugin and the built-in worklist extension SEPARATE module instances,
 * so the process-local capability registry singleton does not always cross that
 * boundary and `resolveSink()` can stay undefined indefinitely even when
 * worklist is loaded. When the in-process sink is unresolvable we therefore use
 * worklist's OFFICIAL out-of-process durable drop-box (PROTOCOL.md §Enqueue
 * paths (b)): atomically write the same stable-id envelope to
 * `$FAMILIAR_WORKLIST_DIR/incoming/<safe-id>.json`. Worklist drains it on its
 * timer and dedupes on the stable id against live+archive. A successful atomic
 * rename IS durable acceptance — only then do we write the tombstone and clear
 * pending/owned. This is still never a direct pi.sendMessage; attention is
 * preserved because worklist owns delivery.
 *
 * Settlements have NO await/claim tool, so there is no await-race to dedup;
 * the sink.withdraw() above is used ONLY for blocked questions (to pull a
 * superseded/stale question once its job unblocks), never for settlements.
 *
 * Durable state (never in source): base dir passed in by the extension, derived
 * from PI_CODING_AGENT_DIR. Files: cursor.json, owned/<jid>.json,
 * pending/<jid>.json, done/<jid>.json, blocked/<jid>.json — all atomic
 * temp+rename, one file per id.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
  DurableSink,
  DurableEnqueueEnvelope,
  SinkPriority,
} from "../../../../integrations/pi/extensions/lib/capabilities.ts";

const TERMINAL = new Set(["done", "failed", "cancelled", "timeout"]);
const isTerminal = (s: unknown): boolean => typeof s === "string" && TERMINAL.has(s);

/** Minimal job/settlement shape we read from GET /v1/jobs/:id. */
export interface JobDetail {
  id?: string;
  state?: string;
  harness?: string;
  model?: string;
  workspace?: Record<string, unknown> | null;
  settlement?: {
    state?: string;
    verdict?: string;
    artifacts?: { path?: string; size?: number }[];
    worktree?: { name?: string; head?: string; dirty?: boolean } | null;
    /** Authoritative usage lives HERE in golemd's live payload (nested under
     *  settlement), not at the top level. Kept optional + unknown so a shape
     *  drift never breaks the relay. */
    usage?: unknown;
  } | null;
  /** Legacy/top-level fallback only; prefer settlement.usage. */
  usage?: unknown;
  /** Present while the job is blocked on an operator question. The live
   *  golemd detail carries the question (prompt + options) and, when the API
   *  provides one, a stable question id that identifies the block episode. */
  question?: { id?: string; prompt?: string; text?: string; options?: unknown[] } | null;
}

/** The Golem transport subset the relay needs. Injectable for tests. */
export interface RelayClient {
  status(id: string): Promise<JobDetail>;
  list(state?: string): Promise<JobDetail[]>;
  streamEvents(
    since: number,
    onEvent: (e: { seq?: number; job_id?: string; state?: string }) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface RelayDeps {
  client: RelayClient;
  /** Durable base directory. Created on demand. */
  stateDir: string;
  /** Lazily resolve the worklist sink from the registry at flush time. */
  resolveSink: () => DurableSink | undefined;
  /** Worklist's out-of-process drop-box directory ($FAMILIAR_WORKLIST_DIR/
   *  incoming). Used as the durable cross-loader fallback when resolveSink()
   *  returns undefined. Must already exist (worklist owns creating its tree);
   *  an absent/unwritable dir makes the relay retain pending instead. */
  dropboxDir?: string;
  now?: () => number;
  log?: (o: unknown) => void;
  /** Periodic tick (cursor persist + pending flush) in ms. */
  tickMs?: number;
  /** Base reconnect backoff in ms (multiplied by attempt, capped). */
  backoffMs?: number;
}

/* --- small durable helpers ------------------------------------------------ */

function writeAtomic(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readJSON<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}
function listIds(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
}
function rm(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/** Sanitize a job id into a filesystem- and worklist-id-safe token. The mapping
 *  is deterministic (stable dedup id) and collision-resistant enough for Golem
 *  job ids (uuid/slug). */
export function safeJobId(jobId: string): string {
  let s = jobId.replace(/[^A-Za-z0-9._-]/g, "-");
  if (!/^[A-Za-z0-9]/.test(s)) s = `j-${s}`;
  return s.slice(0, 120);
}

/** Build a concise, useful worklist envelope from authoritative job detail. */
export function buildEnvelope(jobId: string, job: JobDetail): DurableEnqueueEnvelope {
  const state = job.settlement?.state || job.state || "settled";
  const verdict = (job.settlement?.verdict || "").trim();
  const ok = state === "done";
  const priority: SinkPriority = ok ? 2 : 1;
  const short = verdict ? verdict.replace(/\s+/g, " ").slice(0, 80) : jobId;
  const summary = `agent ${state}: ${short}`;
  const lines: string[] = [`job ${jobId} — ${state}`];
  if (job.harness || job.model) lines.push(`harness/model: ${job.harness ?? "?"}/${job.model ?? "?"}`);
  const ws = job.workspace || undefined;
  if (ws) {
    const wsStr = (ws.project as string) || (ws.repo as string) || (ws.worktree as string) || (ws.path as string);
    if (wsStr) lines.push(`workspace: ${wsStr}${ws.worktree && ws.worktree !== wsStr ? ` @ ${ws.worktree}` : ""}`);
  }
  if (verdict) lines.push("", "verdict:", verdict.slice(0, 2000));
  const arts = job.settlement?.artifacts || [];
  if (arts.length) {
    lines.push("", `artifacts (${arts.length}):`);
    for (const a of arts.slice(0, 12)) lines.push(`  • ${a.path ?? "?"}${typeof a.size === "number" ? ` (${a.size}B)` : ""}`);
    if (arts.length > 12) lines.push(`  … +${arts.length - 12} more`);
  }
  const wt = job.settlement?.worktree;
  if (wt && (wt.name || wt.head)) lines.push("", `worktree: ${wt.name ?? "?"}@${(wt.head ?? "").slice(0, 12)}${wt.dirty ? " (dirty)" : ""}`);
  // golemd nests usage under settlement in its live job payload; prefer that and
  // fall back to any legacy top-level usage.
  const usage = job.settlement?.usage ?? job.usage;
  if (usage !== undefined && usage !== null) {
    let u: string;
    try {
      u = typeof usage === "string" ? usage : JSON.stringify(usage);
    } catch {
      u = String(usage);
    }
    lines.push("", `usage: ${u.slice(0, 500)}`);
  }
  return {
    id: `golem-settle-${safeJobId(jobId)}`,
    priority,
    type: "notify",
    summary: summary.slice(0, 200),
    body: lines.join("\n"),
    source: "golem",
  };
}

/** Short stable content hash (12 hex) — a discriminator when the API gives no
 *  explicit question id, so a distinct question still yields a distinct id. */
function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/**
 * Stable, per-block-episode worklist id for a blocked job.
 *
 * The episode discriminator is the question id when the API provides one (a
 * fresh question id per block, so a re-block is a NEW id and is not suppressed
 * by the prior episode's withdraw tombstone). When no question id is present we
 * fall back to a content hash of the prompt so a distinct question still maps
 * to a distinct id. Either way the id is deterministic, so duplicate SSE events
 * and process restarts dedup to the SAME single item.
 */
export function blockedItemId(jobId: string, question: unknown): string {
  const q = (question && typeof question === "object") ? (question as Record<string, unknown>) : {};
  const qid = typeof q.id === "string" && q.id ? q.id : null;
  const disc = qid
    ? safeJobId(qid)
    : "q" + shortHash(
        (typeof q.prompt === "string" ? q.prompt : "") ||
        (typeof q.text === "string" ? q.text : "") ||
        "no-prompt",
      );
  return `golem-blocked-${safeJobId(jobId)}-${disc}`;
}

/** Build a concise, actionable worklist QUESTION for a blocked job: the job
 *  identity plus the full operator question and its options, with a hint for
 *  how to answer. P0 so it steers promptly (held only under `protected`). */
export function buildBlockedEnvelope(jobId: string, job: JobDetail): DurableEnqueueEnvelope {
  const q = (job.question && typeof job.question === "object") ? (job.question as Record<string, unknown>) : {};
  const prompt =
    (typeof q.prompt === "string" ? q.prompt : "") ||
    (typeof q.text === "string" ? q.text : "") ||
    "(no question text)";
  const options = Array.isArray(q.options)
    ? (q.options as unknown[]).filter((o) => typeof o === "string" || typeof o === "number")
    : [];
  const short = prompt.replace(/\s+/g, " ").trim().slice(0, 80);
  const summary = `agent blocked: ${short}`;
  const lines: string[] = [`job ${jobId} — BLOCKED (needs an answer)`];
  if (job.harness || job.model) lines.push(`harness/model: ${job.harness ?? "?"}/${job.model ?? "?"}`);
  const ws = job.workspace || undefined;
  if (ws) {
    const wsStr = (ws.project as string) || (ws.repo as string) || (ws.worktree as string) || (ws.path as string);
    if (wsStr) lines.push(`workspace: ${wsStr}`);
  }
  lines.push("", "question:", prompt.slice(0, 4000));
  if (options.length) {
    lines.push("", "options:");
    options.slice(0, 20).forEach((o, i) => lines.push(`  ${i + 1}. ${String(o)}`));
    if (options.length > 20) lines.push(`  … +${options.length - 20} more`);
  }
  lines.push("", `answer with: agents_answer { id: "${jobId}", text: "<your answer>" }`);
  return {
    id: blockedItemId(jobId, q),
    priority: 0,
    type: "question",
    summary: summary.slice(0, 200),
    body: lines.join("\n"),
    source: "golem",
  };
}

/* --- the relay ------------------------------------------------------------ */

export class SettlementRelay {
  private readonly d: Required<Pick<RelayDeps, "client" | "stateDir" | "resolveSink">> & RelayDeps;
  private readonly dir: { cursor: string; owned: string; pending: string; done: string; blocked: string };
  private cursor = 0;
  private maxSeq = 0;
  private stopped = true;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private streamLoop?: Promise<void>;
  /** The single serial execution chain. ALL work that reads pending/ and calls
   *  the sink (queue drain, periodic maintenance, reconnect backstop, startup,
   *  recordDispatch) is appended here so the same pending envelope is never
   *  concurrently submitted to the sink. Stable sink ids make a duplicate
   *  harmless, but we do not intentionally race calls. */
  private opChain: Promise<void> = Promise.resolve();
  private readonly queue: string[] = [];

  constructor(deps: RelayDeps) {
    this.d = { tickMs: 20_000, backoffMs: 1_000, now: Date.now, log: () => {}, ...deps };
    this.dir = {
      cursor: path.join(deps.stateDir, "cursor.json"),
      owned: path.join(deps.stateDir, "owned"),
      pending: path.join(deps.stateDir, "pending"),
      done: path.join(deps.stateDir, "done"),
      blocked: path.join(deps.stateDir, "blocked"),
    };
  }

  private log(o: unknown): void {
    try {
      this.d.log!(o);
    } catch {
      /* logging must never throw */
    }
  }

  private ensureDirs(): void {
    for (const dir of [this.d.stateDir, this.dir.owned, this.dir.pending, this.dir.done, this.dir.blocked]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private ownedFile = (jid: string) => path.join(this.dir.owned, `${safeJobId(jid)}.json`);
  private pendingFile = (jid: string) => path.join(this.dir.pending, `${safeJobId(jid)}.json`);
  private doneFile = (jid: string) => path.join(this.dir.done, `${safeJobId(jid)}.json`);
  private blockedFile = (jid: string) => path.join(this.dir.blocked, `${safeJobId(jid)}.json`);

  private isOwned = (jid: string) => fs.existsSync(this.ownedFile(jid));
  private isDone = (jid: string) => fs.existsSync(this.doneFile(jid));

  /** The worklist drop-box target for a job, or undefined if no valid dropbox
   *  dir is configured. The filename is derived from OUR sanitized job id
   *  (independent of any untrusted external id); the envelope's stable `id`
   *  field remains authoritative for worklist's dedup. */
  private dropboxFile(jid: string): string | undefined {
    const dir = this.d.dropboxDir;
    if (!dir) return undefined;
    return path.join(dir, `golem-settle-${safeJobId(jid)}.json`);
  }

  /** Worklist drop-box target for a BLOCKED question, keyed on the stable item
   *  id (per block-episode) so a re-block with a new question does not clobber
   *  a not-yet-drained drop for the prior episode. The envelope's stable `id`
   *  field remains authoritative for worklist's dedup. */
  private dropboxFileBlocked(itemId: string): string | undefined {
    const dir = this.d.dropboxDir;
    if (!dir) return undefined;
    return path.join(dir, `golem-blocked-${safeJobId(itemId)}.json`);
  }

  /** Record that THIS extension dispatched a job. Idempotent. Immediately
   *  reconciles so a very fast job that settled around dispatch registration is
   *  not missed (the fast-settle race). */
  async recordDispatch(jobId: string): Promise<void> {
    if (!jobId) return;
    this.ensureDirs();
    if (!this.isOwned(jobId)) {
      writeAtomic(this.ownedFile(jobId), { id: jobId, ts: this.d.now!() });
    }
    // Best-effort immediate reconcile; a normal (still-running) job is a no-op.
    // Serialized on the shared chain (force: runs even before start()) so it
    // cannot race maintenance/pump for the same pending envelope. Awaited so the
    // fast-settle path is observable.
    await this.enqueueOp("recordDispatch", () => this.reconcileJob(jobId), true);
  }

  /** The single idempotent reconcile unit for an owned job. Fetches
   *  authoritative detail and, depending on state: enqueues/retains a BLOCKED
   *  question (and withdraws a stale one when the job unblocks), or persists a
   *  pending terminal settlement envelope and flushes it. */
  private async reconcileJob(jobId: string): Promise<void> {
    if (!this.isOwned(jobId)) return; // not ours — anti-flood
    if (this.isDone(jobId)) return; // already relayed (terminal)
    // A pending envelope already built (e.g. sink was down) — just flush it.
    if (fs.existsSync(this.pendingFile(jobId))) {
      await this.flushOne(jobId);
      if (this.isDone(jobId)) return;
    }
    let job: JobDetail;
    try {
      job = await this.d.client.status(jobId);
    } catch (err) {
      this.log({ relay: "reconcileJob.status", jobId, err: String(err) });
      return;
    }
    const state = job?.settlement?.state || job?.state;
    if (state === "blocked") {
      // Promptly surface (or retain) the operator question; idempotent per
      // block-episode so duplicate events / restarts do not re-deliver.
      await this.ensureBlocked(jobId, job);
      return;
    }
    // Not blocked: withdraw any live blocked question for this job (answered,
    // unblocked, or went terminal while blocked) so a stale question cannot
    // surface. Idempotent; a no-op when no live marker exists.
    await this.withdrawBlockedIfLive(jobId);
    if (!isTerminal(state)) return; // still running — nothing to settle yet
    writeAtomic(this.pendingFile(jobId), buildEnvelope(jobId, job));
    await this.flushOne(jobId);
  }

  /** Attempt to hand one pending envelope to the worklist. FIRST choice is the
   *  in-process durable sink (fast path). If it is unresolvable across the
   *  extension-loader module boundary (or throws), FALL BACK to worklist's
   *  official out-of-process drop-box: an atomic write of the same stable-id
   *  envelope to $FAMILIAR_WORKLIST_DIR/incoming. A successful atomic rename is
   *  durable acceptance. On acceptance (sink or dropbox) write the done
   *  tombstone and clear pending+owned. If neither is available, RETAIN pending
   *  for a later retry — NEVER a direct pi.sendMessage relay. */
  private async flushOne(jobId: string): Promise<void> {
    const env = readJSON<DurableEnqueueEnvelope>(this.pendingFile(jobId));
    if (!env) return;
    if (this.isDone(jobId)) {
      rm(this.pendingFile(jobId));
      return;
    }
    // Fast path: the in-process capability sink, when the registry singleton
    // actually crosses the loader boundary.
    const sink = this.d.resolveSink();
    if (sink) {
      let acc;
      try {
        acc = await sink.enqueue(env);
      } catch (err) {
        this.log({ relay: "flushOne.enqueueThrew", jobId, err: String(err) });
        acc = undefined; // fall through to the dropbox fallback below
      }
      if (acc && (acc.accepted || acc.superseded)) {
        this.commitDone(jobId, { via: "sink", acceptedId: acc.id, superseded: !!acc.superseded });
        return;
      }
      if (acc && !acc.accepted && !acc.superseded) {
        // An explicit, durable refusal from a REAL sink (e.g. tombstoned). Do
        // not shadow-write a dropbox copy behind the sink's back; retain.
        this.log({ relay: "flushOne.rejected", jobId, reason: acc.reason });
        return;
      }
      // acc === undefined: sink threw. Try the durable dropbox fallback.
    }
    // Fallback path: worklist's official cross-process/cross-loader drop-box.
    if (this.writeDropbox(jobId, env)) {
      this.commitDone(jobId, { via: "dropbox" });
      return;
    }
    // Neither channel available → retain pending; retried on tick/reconnect.
    this.log({ relay: "flushOne.retained", jobId, hadSink: !!sink, dropbox: !!this.d.dropboxDir });
  }

  /** Atomically drop the stable-id envelope into worklist's incoming dir at
   *  `dest`. Returns true iff a durable file now exists for this envelope (fresh
   *  write OR an already-present drop for the same stable id — worklist dedups
   *  either way, so both are "accepted"). Never overwrites a conflicting
   *  envelope silently: a temp+link lands the file, and an existing same-id drop
   *  is left intact. Returns false on any I/O failure (absent/unwritable dir) so
   *  the caller retains the item. */
  private writeDropboxTo(dest: string, env: DurableEnqueueEnvelope): boolean {
    try {
      // If a drop for this exact stable id is already queued (e.g. a prior crash
      // between the atomic write and the tombstone), it is durable acceptance —
      // worklist will drain+dedup it. Never accept an unrelated conflicting file.
      const existing = readJSON<DurableEnqueueEnvelope>(dest);
      if (existing) return existing.id === env.id;

      const tmp = `${dest}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
      try {
        // Publish without replacement: hard-linking the fully-written temp file
        // is atomic and fails with EEXIST if another writer won the destination.
        // Plain rename(2) would silently replace on POSIX, violating the durable
        // drop-box's no-clobber promise.
        fs.linkSync(tmp, dest);
        rm(tmp);
        return true;
      } catch (err) {
        rm(tmp);
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          return readJSON<DurableEnqueueEnvelope>(dest)?.id === env.id;
        }
        throw err;
      }
    } catch (err) {
      this.log({ relay: "writeDropbox.failed", dest, err: String(err) });
      return false;
    }
  }

  /** Drop-box fallback for a terminal settlement (see writeDropboxTo). */
  private writeDropbox(jobId: string, env: DurableEnqueueEnvelope): boolean {
    const dest = this.dropboxFile(jobId);
    if (!dest) return false;
    return this.writeDropboxTo(dest, env);
  }

  /* --- blocked-question lifecycle -----------------------------------------
   * A blocked owned job surfaces a P0 worklist QUESTION promptly (SSE event or
   * the periodic reconcile backstop) and withdraws it when the job leaves
   * `blocked`. Idempotent per block-episode: the stable item id dedups at the
   * sink/drain, and a local `blocked/<jid>` marker records the live episode so
   * restarts neither re-deliver nor strand it. */

  /** Ensure the current block-episode's question is durably enqueued (sink,
   *  else drop-box). No-op when the marker already records this same episode.
   *  Writes the marker only after a durable acceptance, so a failed flush is
   *  retried on the next reconcile. */
  private async ensureBlocked(jobId: string, job: JobDetail): Promise<void> {
    const itemId = blockedItemId(jobId, job.question);
    const markerFile = this.blockedFile(jobId);
    const existing = readJSON<{ itemId?: string }>(markerFile);
    if (existing?.itemId === itemId) return; // same episode already enqueued
    // The episode changed (re-block with a different question): withdraw the
    // prior episode's item so a stale question does not linger.
    if (existing?.itemId && existing.itemId !== itemId) {
      await this.withdrawItem(existing.itemId);
    }
    const env = buildBlockedEnvelope(jobId, job);
    if (await this.flushBlocked(itemId, env)) {
      writeAtomic(markerFile, { jobId, itemId, ts: this.d.now!() });
    }
  }

  /** Hand one blocked-question envelope to the worklist. Same two-channel
   *  policy as settlements: in-process sink first, else the official drop-box.
   *  Returns true iff durably accepted (sink accepted/superseded, or a durable
   *  drop-box file) so the caller may record the live marker. */
  private async flushBlocked(itemId: string, env: DurableEnqueueEnvelope): Promise<boolean> {
    const sink = this.d.resolveSink();
    if (sink) {
      let acc;
      try {
        acc = await sink.enqueue(env);
      } catch (err) {
        this.log({ relay: "flushBlocked.enqueueThrew", itemId, err: String(err) });
        acc = undefined; // fall through to the drop-box fallback below
      }
      if (acc && (acc.accepted || acc.superseded)) return true;
      if (acc && !acc.accepted && !acc.superseded) {
        // An explicit, durable refusal from a REAL sink. Do not shadow-write a
        // drop-box copy behind the sink's back; retain (no marker) so the next
        // reconcile retries.
        this.log({ relay: "flushBlocked.rejected", itemId, reason: acc.reason });
        return false;
      }
      // acc === undefined: sink threw. Try the durable drop-box fallback.
    }
    const dest = this.dropboxFileBlocked(itemId);
    if (dest && this.writeDropboxTo(dest, env)) return true;
    this.log({ relay: "flushBlocked.retained", itemId, hadSink: !!sink, dropbox: !!this.d.dropboxDir });
    return false;
  }

  /** Withdraw this job's live blocked question (if any) and clear the marker.
   *  Idempotent; a no-op when no live marker exists. Called when an owned job
   *  leaves `blocked` (answered / unblocked / went terminal). */
  private async withdrawBlockedIfLive(jobId: string): Promise<void> {
    const markerFile = this.blockedFile(jobId);
    const marker = readJSON<{ itemId?: string }>(markerFile);
    if (!marker?.itemId) return;
    await this.withdrawItem(marker.itemId);
    rm(markerFile);
  }

  /** Withdraw one blocked-question item by its stable id. The in-process sink
   *  is the load-bearing path (it also catches a drop-box drop that worklist has
   *  since drained into its store). Best-effort: also remove an undrained
   *  drop-box file so a stale question cannot surface. Never throws. */
  private async withdrawItem(itemId: string): Promise<void> {
    const sink = this.d.resolveSink();
    if (sink) {
      try {
        await sink.withdraw(itemId);
      } catch (err) {
        this.log({ relay: "withdrawItem.sinkError", itemId, err: String(err) });
      }
    }
    const dest = this.dropboxFileBlocked(itemId);
    if (dest) rm(dest);
  }

  /** Commit a settlement as delivered: tombstone FIRST (so a crash after this
   *  cannot re-enqueue), then clear pending + owned. */
  private commitDone(jobId: string, meta: Record<string, unknown>): void {
    writeAtomic(this.doneFile(jobId), { id: jobId, ts: this.d.now!(), ...meta });
    rm(this.pendingFile(jobId));
    rm(this.ownedFile(jobId));
  }

  /** Flush every retained pending envelope (sink-recovered path). */
  async flushPending(): Promise<void> {
    for (const jid of listIds(this.dir.pending)) {
      try {
        await this.flushOne(jid);
      } catch (err) {
        this.log({ relay: "flushPending", jid, err: String(err) });
      }
    }
  }

  /** Reconcile every owned job that has not yet been relayed. Backstops any
   *  event missed below the cursor (restart / SSE gap / polling fallback). */
  async reconcileOwnedUnsettled(): Promise<void> {
    for (const jid of listIds(this.dir.owned)) {
      if (this.isDone(jid)) continue;
      try {
        await this.reconcileJob(jid);
      } catch (err) {
        this.log({ relay: "reconcileOwned", jid, err: String(err) });
      }
    }
  }

  private loadCursor(): void {
    const c = readJSON<{ seq?: number }>(this.dir.cursor);
    this.cursor = typeof c?.seq === "number" && c.seq >= 0 ? Math.floor(c.seq) : 0;
    this.maxSeq = this.cursor;
  }
  private persistCursor(): void {
    if (this.maxSeq > this.cursor) {
      this.cursor = this.maxSeq;
      try {
        writeAtomic(this.dir.cursor, { seq: this.cursor });
      } catch (err) {
        this.log({ relay: "persistCursor", err: String(err) });
      }
    }
  }

  /** Append work to the single serial chain and resolve when it has run. Errors
   *  are logged, never thrown out of the chain (one failed op must not wedge the
   *  rest). This is the ONE concurrency primitive: nothing that touches pending/
   *  or the sink runs outside it. */
  private enqueueOp<T>(label: string, fn: () => Promise<T>, force = false): Promise<T | undefined> {
    const run = this.opChain.then(async () => {
      // Background ops (tick/pump/reconnect) must not run after stop(); external
      // ops (recordDispatch) pass force so a dispatch's fast-settle reconcile
      // runs even before start() or during shutdown.
      if (this.stopped && !force) return undefined;
      try {
        return await fn();
      } catch (err) {
        this.log({ relay: label, err: String(err) });
        return undefined;
      }
    });
    // Keep the chain alive regardless of this op's outcome.
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Serial drain of SSE-enqueued job ids, then persist the cursor. Scheduled on
   *  the shared chain so it cannot overlap maintenance or the reconnect
   *  backstop. */
  private pump(): void {
    void this.enqueueOp("pump", async () => {
      while (this.queue.length && !this.stopped) {
        const jid = this.queue.shift()!;
        await this.reconcileJob(jid);
      }
      this.persistCursor();
    });
  }

  /** One maintenance pass: persist cursor, reconcile every owned-unsettled job
   *  (the bounded backstop for a healthy-but-silent SSE, or dropped/pruned
   *  events), then flush any retained pending envelope. Serialized. */
  private async maintenance(): Promise<void> {
    this.persistCursor();
    await this.reconcileOwnedUnsettled();
    await this.flushPending();
  }

  private onEvent = (e: { seq?: number; job_id?: string; state?: string }): void => {
    if (typeof e?.seq === "number" && e.seq > this.maxSeq) this.maxSeq = e.seq;
    const jid = e?.job_id;
    if (!jid || !this.isOwned(jid) || this.isDone(jid)) return;
    // Chase terminal transitions (settle) AND `blocked` transitions (surface the
    // operator question promptly). Running churn is ignored here; reconcileJob
    // re-checks authoritative state anyway, so a stale `blocked` event is a
    // no-op once the job has moved on.
    if (e.state && !isTerminal(e.state) && e.state !== "blocked") return;
    if (!this.queue.includes(jid)) this.queue.push(jid);
    this.pump();
  };

  private async streamOnce(): Promise<void> {
    this.abort = new AbortController();
    await this.d.client.streamEvents(this.cursor, this.onEvent, this.abort.signal);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.abort?.signal;
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      // Do not keep the event loop alive for the backoff.
      (t as unknown as { unref?: () => void }).unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async runStream(): Promise<void> {
    let fail = 0;
    while (!this.stopped) {
      try {
        await this.streamOnce();
      } catch (err) {
        this.log({ relay: "stream", err: String(err) });
      }
      if (this.stopped) break;
      // Any stream return is a disconnect (a healthy SSE request stays open).
      fail++;
      // Degrade to polling after repeated failures: reconcile owned-unsettled
      // jobs so a pruned/missed event still settles. Serialized on the chain.
      if (fail >= 3) {
        await this.enqueueOp("reconnect-backstop", () => this.maintenance());
      }
      await this.delay(Math.min(fail, 5) * this.d.backoffMs!);
    }
  }

  // Periodic maintenance backstop. Runs even while SSE is HEALTHY-but-silent:
  // if the endpoint/DB is replaced and its sequence is below our persisted
  // cursor, the stream can stay open forever while future owned settlements
  // never arrive as events. A bounded owned-unsettled reconcile every tickMs
  // guarantees those (and any dropped/pruned events) still settle. Serialized.
  private tick = (): void => {
    void this.enqueueOp("tick", () => this.maintenance());
  };

  /** Start the background consumer. Safe to call once per session_start. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.ensureDirs();
    this.loadCursor();
    // Startup reconciliation: settle anything that terminated while we were down
    // and flush any envelope retained across restart. Serialized on the chain.
    await this.enqueueOp("startup", () => this.maintenance());
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(this.tick, this.d.tickMs!);
    (this.timer as unknown as { unref?: () => void }).unref?.();
    this.streamLoop = this.runStream();
  }

  /** Stop cleanly: abort the in-flight SSE request, clear the timer, drain the
   *  serial op chain. Leaks no timers or sockets. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.abort?.abort();
    try {
      await this.streamLoop;
    } catch {
      /* already logged */
    }
    // Drain whatever is already queued on the chain (in-flight sink calls run to
    // completion) so we never abort mid-enqueue and leave a half state.
    try {
      await this.opChain;
    } catch {
      /* ignore */
    }
    this.persistCursor();
  }
}
