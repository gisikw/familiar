import fs from "fs";

/* Shared debug/error logging for extensions. Writes JSONL sidecar files next
 * to the main log: `${FAMILIAR_LOG_PATH}.${suffix}`.
 *
 * FAMILIAR_DEBUG_LEVEL: "off" | "error" | "debug". Defaults to "debug",
 * which preserves the historical log-everything behavior; flip the default
 * once the firehose spam stops earning its keep.
 */

const LEVELS: Record<string, number> = { off: 0, error: 1, debug: 2 };

function level(): number {
  return LEVELS[process.env.FAMILIAR_DEBUG_LEVEL ?? "debug"] ?? 2;
}

function append(suffix: string, obj: unknown) {
  fs.appendFile(`${process.env.FAMILIAR_LOG_PATH}.${suffix}`, `${JSON.stringify(obj)}\n`, "utf8", () => { });
}

// High-volume diagnostics: event firehoses, draft snapshots.
export function debugLog(suffix: string, obj: unknown) {
  if (level() >= 2) append(suffix, obj);
}

// Faults worth keeping even when debug spam is off.
export function errorLog(suffix: string, obj: unknown) {
  if (level() >= 1) append(suffix, obj);
}
