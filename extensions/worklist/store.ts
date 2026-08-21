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

/** Create the state tree if missing. Graceful on a cold repo. Runs a one-shot
 *  legacy migration from an adjacent state/inbox/ tree so queued items and the
 *  persisted posture are never lost across the rename. */
export function ensureDirs(p: WorklistPaths, legacyRoot?: string): void {
  const fresh = !fs.existsSync(p.root);
  for (const d of [p.root, p.items, p.archive, p.incoming]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (fresh && legacyRoot && fs.existsSync(legacyRoot)) {
    try {
      migrateLegacy(legacyRoot, p);
    } catch {
      /* migration is best-effort; a partial copy still loses nothing on disk */
    }
  }
}

/** Copy any legacy inbox items/incoming and translate posture.json → attention.
 *  Idempotent enough: only runs when the worklist root was just created. */
function migrateLegacy(legacyRoot: string, p: WorklistPaths): void {
  const legacyItems = path.join(legacyRoot, "items");
  const legacyIncoming = path.join(legacyRoot, "incoming");
  const legacyPosture = path.join(legacyRoot, "posture.json");
  const copyDir = (src: string, dst: string) => {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(src)) {
      const s = path.join(src, n);
      if (!fs.statSync(s).isFile()) continue; // skip archive/ subdir here
      try {
        fs.copyFileSync(s, path.join(dst, n));
      } catch {
        /* skip */
      }
    }
  };
  copyDir(legacyItems, p.items);
  copyDir(path.join(legacyItems, "archive"), p.archive);
  copyDir(legacyIncoming, p.incoming);
  // posture.json { mode } → attention.json { mode } (override starts clear; a
  // legacy permanent "busy" becomes a fresh auto inference, which is correct —
  // nothing should carry an unbounded suppression across the rename).
  const legacy = readJSON<{ mode?: string }>(legacyPosture);
  if (legacy && legacy.mode && !fs.existsSync(p.attention)) {
    const mode: AttentionMode =
      legacy.mode === "busy" ? "focused" : legacy.mode === "available" ? "available" : "auto";
    // A legacy manual pin had no expiry; drop it to auto so nothing is unbounded.
    writeAttention(p, { mode: mode === "focused" ? "auto" : mode, override: null });
  }
}

/** Atomic write: temp + rename. Cross-process senders depend on this. */
export function writeJSONAtomic(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
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
  let names: string[];
  try {
    names = fs.readdirSync(p.incoming);
  } catch {
    return [];
  }
  const created: QueueItem[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const src = path.join(p.incoming, n);
    // Claim by renaming out of the drop-box; loser of a race gets ENOENT.
    const claimed = `${src}.claimed`;
    try {
      fs.renameSync(src, claimed);
    } catch {
      continue;
    }
    const env = readJSON<EnqueueEnvelope>(claimed);
    try {
      fs.unlinkSync(claimed);
    } catch {
      /* nothing */
    }
    if (!env || !env.summary) continue; // skip malformed
    // Dedup on stable id: don't resurrect an already-known (or withdrawn) item.
    if (env.id && itemExists(p, env.id)) continue;
    const item = envelopeToItem(env, now);
    putItem(p, item);
    created.push(item);
  }
  return created;
}

/** True iff an item with this id is live or archived. */
export function itemExists(p: WorklistPaths, id: string): boolean {
  return fs.existsSync(itemFile(p, id)) || fs.existsSync(path.join(p.archive, `${id}.json`));
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

export function readAttention(p: WorklistPaths): AttentionState {
  const raw = readJSON<AttentionState>(p.attention);
  if (!raw) return { mode: "auto", override: null };
  return { mode: raw.mode ?? "auto", override: raw.override ?? null };
}

export function writeAttention(p: WorklistPaths, s: AttentionState): void {
  writeJSONAtomic(p.attention, s);
}
