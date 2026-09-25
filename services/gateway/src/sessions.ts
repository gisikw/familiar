import fs from "node:fs";
import path from "node:path";
import type { ChannelRegistry, SessionRole } from "./channels.ts";

export type SessionState = "live" | "merging" | "merged" | "stopped";
export interface SessionSummary {
  id: string;
  role: SessionRole;
  parentSessionId: string | null;
  task: string | null;
  state: SessionState;
  startedAt: string;
  lastEventAt: string;
}

type CachedState = { mtimeMs: number; size: number; state: "merging" | "merged" | undefined };
const sessionStateCache = new Map<string, CachedState>();

/** Read merge markers in append order. Cache unchanged JSONL files by mtime and
 * size; malformed/incomplete tail records are ignored like Pi's own readers. */
export function mergeStateFromJsonl(file: string): "merging" | "merged" | undefined {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return undefined; }
  const cached = sessionStateCache.get(file);
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.state;

  let pending = -1;
  let sent = -1;
  try {
    // Merge markers are written at the end of a fork's life. Bound discovery
    // work for very long transcripts; the first partial line is harmless.
    const cap = 512 * 1024;
    const length = Math.min(stat.size, cap);
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buffer, 0, length, stat.size - length); }
    finally { fs.closeSync(fd); }
    const lines = buffer.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]);
        const customType = entry?.customType ?? entry?.message?.customType;
        if (customType === "familiar.merge-pending.v1") pending = i;
        if (customType === "familiar.merge-sent.v1") sent = i;
      } catch { /* tolerate a damaged or concurrently appended record */ }
    }
  } catch { /* state remains unknown */ }
  const state = pending > sent ? "merging" : sent >= 0 ? "merged" : undefined;
  sessionStateCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, state });
  return state;
}

export class SessionCatalog {
  constructor(private registry: ChannelRegistry, private stateDir = process.env.FAMILIAR_STATE_DIR) {}

  list(): SessionSummary[] {
    const byId = new Map<string, SessionSummary>();
    const forksRoot = this.stateDir ? path.join(this.stateDir, "forks") : undefined;
    if (forksRoot) {
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(forksRoot, { withFileTypes: true }); } catch { /* no forks yet */ }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const root = path.join(forksRoot, entry.name);
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(root, "fork.json"), "utf8"));
          if (typeof meta.id !== "string" || meta.id !== entry.name) continue;
          const sessionFile = path.join(root, "sessions", path.basename(String(meta.sessionFile ?? "")));
          let fileTime: Date | undefined;
          try { fileTime = fs.statSync(sessionFile).mtime; } catch { /* absent session is stopped */ }
          const marker = mergeStateFromJsonl(sessionFile);
          const live = this.registry.channels.get(meta.id)?.relay.hasSubscriber() === true;
          const startedAt = typeof meta.createdAt === "string" ? meta.createdAt : fileTime?.toISOString() ?? new Date(0).toISOString();
          byId.set(meta.id, {
            id: meta.id,
            role: "fork",
            parentSessionId: typeof meta.parentSessionId === "string" ? meta.parentSessionId : null,
            task: typeof meta.task === "string" ? meta.task : null,
            state: marker ?? (live ? "live" : "stopped"),
            startedAt,
            lastEventAt: this.registry.channels.get(meta.id)?.lastEventAt ?? fileTime?.toISOString() ?? startedAt,
          });
        } catch { /* skip malformed/in-progress fork metadata */ }
      }
    }

    for (const channel of this.registry.channels.values()) {
      const prior = byId.get(channel.id);
      byId.set(channel.id, {
        id: channel.id,
        role: channel.role,
        parentSessionId: channel.parentSessionId ?? prior?.parentSessionId ?? null,
        task: prior?.task ?? null,
        state: prior?.state === "merging" || prior?.state === "merged"
          ? prior.state : channel.relay.hasSubscriber() ? "live" : "stopped",
        startedAt: prior?.startedAt ?? channel.startedAt,
        lastEventAt: channel.lastEventAt,
      });
    }
    return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
