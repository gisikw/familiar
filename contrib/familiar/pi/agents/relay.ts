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
 * EXACTLY-ONCE (best-effort, three layers):
 *   1. stable worklist item id → the sink dedupes on it.
 *   2. local `done/<jid>` tombstone → skip already-relayed settlements.
 *   3. `pending/<jid>` durable envelope → the retriable work item; survives
 *      restart and sink-unavailability. Cursor is an optimization only:
 *      startup + failure reconciliation over owned-unsettled jobs backstops any
 *      event missed below the persisted cursor.
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
 * This client has NO await/claim tool, so there is no await-race to dedup and
 * we deliberately do NOT call sink.withdraw() or fake a partial claim protocol.
 *
 * Durable state (never in source): base dir passed in by the extension, derived
 * from PI_CODING_AGENT_DIR. Files: cursor.json, owned/<jid>.json,
 * pending/<jid>.json, done/<jid>.json — all atomic temp+rename, one file per id.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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

/* --- the relay ------------------------------------------------------------ */

export class SettlementRelay {
  private readonly d: Required<Pick<RelayDeps, "client" | "stateDir" | "resolveSink">> & RelayDeps;
  private readonly dir: { cursor: string; owned: string; pending: string; done: string };
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
    for (const dir of [this.d.stateDir, this.dir.owned, this.dir.pending, this.dir.done]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private ownedFile = (jid: string) => path.join(this.dir.owned, `${safeJobId(jid)}.json`);
  private pendingFile = (jid: string) => path.join(this.dir.pending, `${safeJobId(jid)}.json`);
  private doneFile = (jid: string) => path.join(this.dir.done, `${safeJobId(jid)}.json`);

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

  /** The single idempotent settlement unit. Fetches authoritative detail and,
   *  if the owned job is terminal, persists a pending envelope and flushes it. */
  private async reconcileJob(jobId: string): Promise<void> {
    if (!this.isOwned(jobId)) return; // not ours — anti-flood
    if (this.isDone(jobId)) return; // already relayed
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
    if (!isTerminal(state)) return; // still running/blocked — nothing to do
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

  /** Atomically drop the stable-id envelope into worklist's incoming dir. Returns
   *  true iff a durable file now exists for this settlement (fresh write OR an
   *  already-present drop for the same stable id — worklist dedups either way,
   *  so both are "accepted"). Never overwrites a conflicting envelope silently:
   *  a temp+rename lands the file, and an existing same-id drop is left intact.
   *  Returns false on any I/O failure (absent/unwritable dir) so pending is
   *  retained. */
  private writeDropbox(jobId: string, env: DurableEnqueueEnvelope): boolean {
    const dest = this.dropboxFile(jobId);
    if (!dest) return false;
    try {
      // If a drop for this exact stable id is already queued (e.g. a prior crash
      // between the atomic write and the tombstone), it is durable acceptance —
      // worklist will drain+dedup it. Do not rewrite/overwrite it.
      if (fs.existsSync(dest)) return true;
      const tmp = `${dest}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
      try {
        fs.renameSync(tmp, dest);
      } catch (err) {
        rm(tmp);
        throw err;
      }
      return true;
    } catch (err) {
      this.log({ relay: "writeDropbox.failed", jobId, err: String(err) });
      return false;
    }
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
    // Only chase terminal transitions; running/blocked churn is ignored here
    // (reconcileJob re-checks authoritative state anyway).
    if (e.state && !isTerminal(e.state)) return;
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
