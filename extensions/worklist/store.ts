/* ============================================================================
 * Worklist store — durable queue + cross-process enqueue drain (I/O only)
 * ============================================================================
 *
 * The queue must survive session restarts (/reload, /new, /fork, crash) and
 * accept writes from OTHER processes (familiar.sh worklist-add, cron,
 * subscribers). So it lives on disk, not just in memory. Two surfaces:
 *
 *   state/worklist/items/<id>.json   one file per live queue item (the queue)
 *   state/worklist/incoming/*.json   drop-box: cross-process senders write
 *                                    here; the extension drains it on its timer
 *                                    and promotes each envelope into an item.
 *
 * One-file-per-item (vs. a single jsonl) is deliberate: senders are concurrent
 * and out-of-process, and per-file writes with temp+rename are atomic without
 * a lock. A torn jsonl append would corrupt the whole queue; a torn item file
 * is one skippable item. Acked items are moved to items/archive/ rather than
 * deleted, so /peek history and audit survive.
 *
 * Migration: earlier releases stored under state/inbox/ with posture.json. On
 * first ensureDirs() we adopt any legacy tree once, never losing queued items.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { QueueItem, Priority, ItemType, AttentionMode, AttentionOverride } from "./policy.ts";
import { sanitizeOverride } from "./policy.ts";

export interface WorklistPaths {
  root: string;
  items: string;
  archive: string;
  incoming: string;
  attention: string;
}

export function worklistPaths(root: string): WorklistPaths {
  return {
    root,
    items: path.join(root, "items"),
    archive: path.join(root, "items", "archive"),
    incoming: path.join(root, "incoming"),
    attention: path.join(root, "attention.json"),
  };
}

/** Create the state tree and reconcile the compatibility tree. Reconciliation
 * runs on every call: a crash or pre-created/partial destination must not make
 * migration a one-shot event. Legacy sources are removed only after the
 * destination is durable (or already known), so old writers remain supported. */
export function ensureDirs(p: WorklistPaths, legacyRoot?: string): void {
  for (const d of [p.root, p.items, p.archive, p.incoming]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  if (legacyRoot && fs.existsSync(legacyRoot) && path.resolve(legacyRoot) !== path.resolve(p.root)) {
    migrateLegacy(legacyRoot, p);
  }
}

function migrateLegacy(legacyRoot: string, p: WorklistPaths): void {
  const conflicts = path.join(p.root, "migration-conflicts");
  const reconcileItems = (srcDir: string, archived: boolean) => {
    let names: string[];
    try { names = fs.readdirSync(srcDir); } catch { return; }
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const src = path.join(srcDir, n);
      const item = readJSON<QueueItem>(src);
      if (!item?.id) continue; // malformed remains available for repair/retry
      const known = getKnownItem(p, item.id);
      if (known) {
        if (JSON.stringify(known) !== JSON.stringify(item)) {
          fs.mkdirSync(conflicts, { recursive: true, mode: 0o700 });
          const conflict = path.join(conflicts, `${archived ? "archive-" : "live-"}${n}`);
          if (!fs.existsSync(conflict)) writeJSONAtomic(conflict, item);
        }
      } else {
        writeJSONAtomic(path.join(archived ? p.archive : p.items, `${item.id}.json`), item);
      }
      // The durable destination/conflict now owns this exact source.
      try { fs.unlinkSync(src); } catch { /* retry next reconciliation */ }
    }
  };
  const legacyItems = path.join(legacyRoot, "items");
  reconcileItems(path.join(legacyItems, "archive"), true);
  reconcileItems(legacyItems, false);

  // Promote legacy drop-box files with the same recoverable claim protocol as
  // the canonical incoming directory. This is deliberately continuous for the
  // compatibility release: an old process may write after initial migration.
  drainIncomingDirectory(p, path.join(legacyRoot, "incoming"));

  const legacy = readJSON<{ mode?: string }>(path.join(legacyRoot, "posture.json"));
  if (legacy?.mode && !fs.existsSync(p.attention)) {
    const mode: AttentionMode = legacy.mode === "available" ? "available" : "auto";
    writeAttention(p, { mode, override: null });
  }
}

/** Atomic write: temp + rename. Cross-process senders depend on this. */
export function writeJSONAtomic(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJSON<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

const itemFile = (p: WorklistPaths, id: string) => path.join(p.items, `${id}.json`);

export function putItem(p: WorklistPaths, item: QueueItem): void {
  writeJSONAtomic(itemFile(p, item.id), item);
}

export function getItem(p: WorklistPaths, id: string): QueueItem | null {
  return readJSON<QueueItem>(itemFile(p, id));
}

export function getArchivedItem(p: WorklistPaths, id: string): QueueItem | null {
  return readJSON<QueueItem>(path.join(p.archive, `${id}.json`));
}

/** Read terminal history as well as the live queue. */
export function getKnownItem(p: WorklistPaths, id: string): QueueItem | null {
  return getItem(p, id) ?? getArchivedItem(p, id);
}

/** All live (non-archived) items, oldest first. Skips torn/partial files. */
export function listItems(p: WorklistPaths): QueueItem[] {
  let names: string[];
  try {
    names = fs.readdirSync(p.items);
  } catch {
    return [];
  }
  const items: QueueItem[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const it = readJSON<QueueItem>(path.join(p.items, n));
    if (it && it.id) items.push(it);
  }
  return items.sort((a, b) => a.ts - b.ts);
}

/** Move an item to the archive (acked/resolved/withdrawn). Idempotent. */
export function archiveItem(p: WorklistPaths, id: string): void {
  const src = itemFile(p, id);
  const item = readJSON<QueueItem>(src);
  if (!item) return;
  writeJSONAtomic(path.join(p.archive, `${id}.json`), item);
  try {
    fs.unlinkSync(src);
  } catch {
    /* already gone */
  }
}

/* --- enqueue envelope ------------------------------------------------------
 * The stable contract every sender (in-process API, familiar.sh, cron) writes.
 * Documented in PROTOCOL.md. Missing fields get sane defaults so a minimal
 * `{ summary }` envelope is valid.
 */
export interface EnqueueEnvelope {
  priority?: Priority;
  type?: ItemType;
  summary: string;
  body?: string;
  source?: string;
  suggested_deadline?: number;
  /** Optional caller-supplied id (for idempotent re-enqueue); else minted. */
  id?: string;
}

export function envelopeToItem(env: EnqueueEnvelope, now = Date.now()): QueueItem {
  return {
    id: env.id || mintId(),
    ts: now,
    priority: (env.priority ?? 2) as Priority,
    type: env.type ?? "notify",
    summary: env.summary,
    body: env.body ?? env.summary,
    source: env.source ?? "unknown",
    ...(typeof env.suggested_deadline === "number"
      ? { suggested_deadline: env.suggested_deadline }
      : {}),
    surfacedCount: 0,
  };
}

export function mintId(): string {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `wl-${t}-${randomUUID().slice(0, 4)}`;
}

/**
 * Drain the incoming drop-box: read each envelope, promote to a queue item,
 * delete the marker. Returns the newly-created items. Torn/partial files are
 * left in place (a half-written drop reappears whole next tick). Claiming is
 * by rename-into-processing so two drains can't double-promote.
 *
 * Idempotent on envelope id: if an item with the same id already exists (live
 * or archived), the drop is discarded rather than duplicated. This is what
 * makes an out-of-process re-enqueue with a stable id safe.
 */
export function drainIncoming(p: WorklistPaths, now = Date.now()): QueueItem[] {
  return drainIncomingDirectory(p, p.incoming, now);
}

/** Recover both fresh drops and claims left by a dead process. The claim is
 * retained until putItem is durably renamed; malformed claims are retained for
 * diagnosis/retry instead of silently discarded. */
function drainIncomingDirectory(p: WorklistPaths, dir: string, now = Date.now()): QueueItem[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const created: QueueItem[] = [];
  // Claims first makes restart recovery deterministic.
  names.sort((a, b) => Number(!a.endsWith(".claimed")) - Number(!b.endsWith(".claimed")));
  for (const n of names) {
    if (!n.endsWith(".json") && !n.endsWith(".json.claimed")) continue;
    const src = path.join(dir, n);
    const claimed = n.endsWith(".claimed") ? src : `${src}.claimed`;
    if (claimed !== src) {
      try { fs.renameSync(src, claimed); } catch { continue; }
    }
    let env = readJSON<EnqueueEnvelope>(claimed);
    if (!env?.summary) continue;
    // Persist a minted id into the claim before promotion. Without this, death
    // after putItem but before unlink would replay an id-less envelope as a
    // second item on restart.
    if (!env.id) {
      env = { ...env, id: mintId() };
      writeJSONAtomic(claimed, env);
    }
    const result = enqueueEnvelopeIdempotent(p, env, now);
    if (result.created) created.push(result.item);
    // Whether newly written or deduped, a durable live/archive copy owns it.
    try { fs.unlinkSync(claimed); } catch { /* harmless; restart dedupes it */ }
  }
  return created;
}

/** Single conflict-safe enqueue primitive for every ingress path. */
export function enqueueEnvelopeIdempotent(
  p: WorklistPaths,
  env: EnqueueEnvelope,
  now = Date.now(),
): { item: QueueItem; created: boolean } {
  if (env.id) {
    const known = getKnownItem(p, env.id);
    if (known) return { item: known, created: false };
  }
  const item = envelopeToItem(env, now);
  putItem(p, item);
  return { item, created: true };
}

/** True iff an item with this id is live or archived. */
export function itemExists(p: WorklistPaths, id: string): boolean {
  return getKnownItem(p, id) !== null;
}

/* --- attention persistence -------------------------------------------------
 * Only the manual override + mode are persisted. Inference inputs (activity,
 * agentBusy) are volatile and reseed each session. The override carries an
 * absolute wall-clock `expiresAt`, so a `/protect 30m` set at 14:00 still
 * expires at 14:30 after a crash — and an already-expired override is discarded
 * on load. Nothing manual is ever unbounded across restart.
 */
export interface AttentionState {
  mode: AttentionMode;
  override: AttentionOverride | null;
}

export function readAttention(p: WorklistPaths, now = Date.now()): AttentionState {
  const raw = readJSON<{ mode?: unknown; override?: unknown }>(p.attention);
  if (!raw) return { mode: "auto", override: null };
  // Persisted state is untrusted: validate the enum and clamp any far-future
  // remaining lifetime to the ceiling so a corrupt file, clock rollback, or
  // older writer can never hold `protected` longer than the hard cap.
  const override = sanitizeOverride(raw.override, now);
  const mode: AttentionMode =
    raw.mode === "available" || raw.mode === "focused" || raw.mode === "protected"
      ? raw.mode
      : "auto";
  // If the persisted override was clamped/dropped, persist the normalized state
  // atomically so disk stays honest.
  const rawOv = (raw as { override?: unknown }).override ?? null;
  const normalizedChanged =
    JSON.stringify(rawOv) !== JSON.stringify(override) ||
    (raw.mode ?? "auto") !== mode;
  if (normalizedChanged) {
    try { writeAttention(p, { mode, override }); } catch { /* read stays valid even if we can't rewrite */ }
  }
  return { mode, override };
}

export function writeAttention(p: WorklistPaths, s: AttentionState): void {
  writeJSONAtomic(p.attention, s);
}
