import fs from "fs";

/* Server-side logging. Mirrors extensions/lib/debug.ts: JSONL sidecar files
 * next to FAMILIAR_LOG_PATH (`${FAMILIAR_LOG_PATH}.${suffix}`) when set,
 * otherwise stderr. FAMILIAR_DEBUG_LEVEL: "off" | "error" | "debug".
 */

const LEVELS: Record<string, number> = { off: 0, error: 1, debug: 2 };

function level(): number {
  return LEVELS[process.env.FAMILIAR_DEBUG_LEVEL ?? "debug"] ?? 2;
}

function append(suffix: string, obj: unknown) {
  const line = `${JSON.stringify(obj)}\n`;
  const base = process.env.FAMILIAR_LOG_PATH;
  if (base) fs.appendFile(`${base}.${suffix}`, line, "utf8", () => { });
  else process.stderr.write(`[${suffix}] ${line}`);
}

export function debugLog(suffix: string, obj: unknown) {
  if (level() >= 2) append(suffix, obj);
}

export function errorLog(suffix: string, obj: unknown) {
  if (level() >= 1) append(suffix, obj);
}
