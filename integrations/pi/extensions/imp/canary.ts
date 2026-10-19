import { appendFileSync } from "node:fs";
import { join } from "node:path";

// Fork-cache canary (Oct 18 2026). A fork inherits its parent's conversation,
// so its first model call should read nearly the parent's whole prefix from the
// prompt cache. From Oct 4 to Oct 18 almost none did (a context hook rendered a
// timestamp differently live vs from disk; see scheduler/stamp.ts RULE), and
// nothing noticed for two weeks. This records every fork's first call next to
// the parent's last prefix and flags the misses.

export const CANARY_FLOOR = 0.5;

type Usage = { input?: number; cacheRead?: number; cacheWrite?: number };
type Entry = { type?: string; customType?: string; data?: any; message?: any };

export type CanaryReading = {
  parentPrefix: number;
  cacheRead: number;
  cacheWrite: number;
  ratio: number;
  model?: string;
  parentModel?: string;
  miss: boolean;
};

const prefixOf = (u: Usage | undefined) => (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);

/** Read the fork's branch at its first assistant reply. Undefined when this
 * isn't that moment: not a fork, a --fresh fork (no inherited assistant), or a
 * later call. A model switch (--model) is reported but never flagged: a
 * different model can't share the parent's cache. */
export function readCanary(branch: Entry[]): CanaryReading | undefined {
  const marker = branch.findLastIndex((e) => e.type === "custom" && e.customType === "familiar.fork.v1");
  if (marker < 0) return undefined;
  const assistants = (from: number, to: number) => branch.slice(from, to)
    .filter((e) => e.type === "message" && e.message?.role === "assistant" && e.message?.usage);
  const after = assistants(marker + 1, branch.length);
  if (after.length !== 1) return undefined;
  const parent = assistants(0, marker).at(-1);
  if (!parent) return undefined;
  const parentPrefix = prefixOf(parent.message.usage);
  if (parentPrefix <= 0) return undefined;
  const u: Usage = after[0].message.usage;
  const cacheRead = u.cacheRead ?? 0;
  const ratio = cacheRead / parentPrefix;
  const model = after[0].message.model;
  const parentModel = parent.message.model;
  const sameModel = !model || !parentModel || model === parentModel;
  return { parentPrefix, cacheRead, cacheWrite: u.cacheWrite ?? 0, ratio, model, parentModel, miss: sameModel && ratio < CANARY_FLOOR };
}

/** Append one line per fork to $FAMILIAR_STATE_DIR/fork-cache-canary.jsonl. */
export function recordCanary(stateDir: string | undefined, forkId: string | undefined, reading: CanaryReading, now = new Date()) {
  if (!stateDir) return;
  try {
    appendFileSync(join(stateDir, "fork-cache-canary.jsonl"),
      JSON.stringify({ at: now.toISOString(), forkId, ...reading, ratio: Math.round(reading.ratio * 1000) / 1000 }) + "\n");
  } catch { /* the canary must never break a fork */ }
}
