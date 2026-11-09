import fs from "fs";

/* Server-side logging. Mirrors integrations/pi/extensions/lib/debug.ts: JSONL sidecar files
 * next to FAMILIAR_LOG_PATH (`${FAMILIAR_LOG_PATH}.${suffix}`) when set,
 * otherwise stderr. FAMILIAR_DEBUG_LEVEL: "off" | "error" | "debug".
 *
 * Errors are the exception: they always go to stderr as well. The supervisor
 * keeps the gateway's stderr in a bounded rolling file (state/server/
 * gateway.log), while a sidecar can be pointed anywhere. On kestrel every
 * sidecar has been a symlink to /dev/null since Aug 30, so until this an
 * error such as a failed synthesis left no trace at all (found Nov 9 while
 * tracing a reply that never played).
 */

const LEVELS: Record<string, number> = { off: 0, error: 1, debug: 2 };

function level(): number {
  return LEVELS[process.env.FAMILIAR_DEBUG_LEVEL ?? "debug"] ?? 2;
}

function toStderr(suffix: string, obj: unknown) {
  process.stderr.write(`[${suffix}] ${JSON.stringify(obj)}\n`);
}

function append(suffix: string, obj: unknown) {
  const base = process.env.FAMILIAR_LOG_PATH;
  if (base) fs.appendFile(`${base}.${suffix}`, `${JSON.stringify(obj)}\n`, "utf8", () => { });
  else toStderr(suffix, obj);
}

export function debugLog(suffix: string, obj: unknown) {
  if (level() >= 2) append(suffix, obj);
}

export function errorLog(suffix: string, obj: unknown) {
  if (level() < 1) return;
  toStderr(`error:${suffix}`, { at: new Date().toISOString(), error: obj });
  if (process.env.FAMILIAR_LOG_PATH) append(suffix, obj);
}
