/* ============================================================================
 * Inbox store — durable queue + cross-process enqueue drain (I/O only)
 * ============================================================================
 *
 * The queue must survive session restarts (/reload, /new, /fork, crash) and
 * accept writes from OTHER processes (familiar.sh inbox-enqueue, future cron,
 * subscribers). So it lives on disk, not just in memory. Two surfaces:
 *
 *   state/inbox/items/<id>.json   one file per live queue item (the queue)
 *   state/inbox/incoming/*.json   drop-box: cross-process senders write here;
 *                                 the extension drains it on its timer and
 *                                 promotes each envelope into an item.
 *
 * One-file-per-item (vs. a single jsonl) is deliberate: senders are concurrent
 * and out-of-process, and per-file writes with temp+rename are atomic without
 * a lock. A torn jsonl append would corrupt the whole queue; a torn item file
 * is one skippable item. Acked items are moved to items/archive/ rather than
 * deleted, so /peek history and audit survive.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { QueueItem, Priority, ItemType } from "./policy.ts";

export interface InboxPaths {
  root: string;
  items: string;
  archive: string;
  incoming: string;
  posture: string;
}

export function inboxPaths(root: string): InboxPaths {
  return {
    root,
    items: path.join(root, "items"),
    archive: path.join(root, "items", "archive"),
    incoming: path.join(root, "incoming"),
    posture: path.join(root, "posture.json"),
  };
}

/** Create the state tree if missing. Graceful on a cold repo. */
export function ensureDirs(p: InboxPaths): void {
  for (const d of [p.root, p.items, p.archive, p.incoming]) {
    fs.mkdirSync(d, { recursive: true });
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

const itemFile = (p: InboxPaths, id: string) => path.join(p.items, `${id}.json`);

export function putItem(p: InboxPaths, item: QueueItem): void {
  writeJSONAtomic(itemFile(p, item.id), item);
}

export function getItem(p: InboxPaths, id: string): QueueItem | null {
  return readJSON<QueueItem>(itemFile(p, id));
}

/** All live (non-archived) items, oldest first. Skips torn/partial files. */
export function listItems(p: InboxPaths): QueueItem[] {
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

/** Move an item to the archive (acked/resolved). Idempotent. */
export function archiveItem(p: InboxPaths, id: string): void {
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
 * The stable contract every sender (in-process API, familiar.sh, future cron)
 * writes. Documented in PROTOCOL.md. Missing fields get sane defaults so a
 * minimal `{ summary }` envelope is valid.
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
  return `inbox-${t}-${randomUUID().slice(0, 4)}`;
}

/**
 * Drain the incoming drop-box: read each envelope, promote to a queue item,
 * delete the marker. Returns the newly-created items. Torn/partial files are
 * left in place (a half-written drop reappears whole next tick). Claiming is
 * by rename-into-processing so two drains can't double-promote.
 */
export function drainIncoming(p: InboxPaths, now = Date.now()): QueueItem[] {
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
    const item = envelopeToItem(env, now);
    putItem(p, item);
    created.push(item);
  }
  return created;
}

/* --- posture persistence --------------------------------------------------- */
export interface PostureState {
  mode: "auto" | "available" | "busy";
}

export function readPosture(p: InboxPaths): PostureState {
  return readJSON<PostureState>(p.posture) ?? { mode: "auto" };
}

export function writePosture(p: InboxPaths, s: PostureState): void {
  writeJSONAtomic(p.posture, s);
}
