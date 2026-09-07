import * as fs from "node:fs";
import * as path from "node:path";

export type WakeMode = "unless_wakened" | "always";

export interface WakeRecord {
  version: 1;
  id: string;
  mode: WakeMode;
  reason: string;
  scheduledAt: number;
  fireAt: number;
}

export interface WakePaths {
  root: string;
  pending: string;
  fired: string;
  quarantine: string;
}

export interface WakeStateRoots {
  canonical: string;
  legacy: string[];
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const MAX_RECORD_BYTES = 65_536;

/** Resolve the durable store without relying on familiar.sh having run in the
 * current process. Presence can survive a source upgrade, so an extension
 * loaded by /reload may see the old environment. The pi and Presence stores
 * are children of Familiar's state root; wakes are their sibling, not a child.
 *
 * legacy is intentionally bounded to the two incorrect roots emitted by the
 * first durable-wake release. Remove this compatibility list after one release.
 */
export function wakeStateRoots(env: NodeJS.ProcessEnv = process.env): WakeStateRoots {
  const piDir = env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR) : undefined;
  const presenceDir = env.FAMILIAR_PRESENCE_STATE_DIR
    ? path.resolve(env.FAMILIAR_PRESENCE_STATE_DIR)
    : undefined;
  const canonical = env.FAMILIAR_WAKE_DIR
    ? path.resolve(env.FAMILIAR_WAKE_DIR)
    : piDir
      ? path.join(path.dirname(piDir), "wakes")
      : presenceDir
        ? path.join(path.dirname(presenceDir), "wakes")
        : path.resolve(".familiar-wakes");
  const candidates: string[] = [];
  if (presenceDir) candidates.push(path.join(presenceDir, "wakes"));
  if (piDir) candidates.push(path.join(piDir, "wakes"));
  const legacy = candidates.filter((root) => path.resolve(root) !== path.resolve(canonical));
  return { canonical, legacy: [...new Set(legacy)] };
}

export function wakePaths(root: string): WakePaths {
  return {
    root,
    pending: path.join(root, "pending"),
    fired: path.join(root, "fired"),
    quarantine: path.join(root, "quarantine"),
  };
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`unsafe wake state directory: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
}

export function ensureWakeDirs(paths: WakePaths): void {
  ensureDirectory(paths.root);
  ensureDirectory(paths.pending);
  ensureDirectory(paths.fired);
  ensureDirectory(paths.quarantine);
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function writeWakeAtomic(file: string, record: WakeRecord): void {
  ensureDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    syncDirectory(path.dirname(file));
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* absent */ }
    throw error;
  }
}

export function validWake(value: unknown): value is WakeRecord {
  if (!value || typeof value !== "object") return false;
  const wake = value as Partial<WakeRecord>;
  return wake.version === 1
    && typeof wake.id === "string" && ID_RE.test(wake.id)
    && (wake.mode === "always" || wake.mode === "unless_wakened")
    && typeof wake.reason === "string" && wake.reason.length <= 16_384
    && typeof wake.scheduledAt === "number" && Number.isSafeInteger(wake.scheduledAt) && wake.scheduledAt >= 0
    && typeof wake.fireAt === "number" && Number.isSafeInteger(wake.fireAt) && wake.fireAt >= wake.scheduledAt;
}

function pendingFile(paths: WakePaths, id: string): string {
  if (!ID_RE.test(id)) throw new Error("invalid wake id");
  return path.join(paths.pending, `${id}.json`);
}

export function putWake(paths: WakePaths, wake: WakeRecord): void {
  if (!validWake(wake)) throw new Error("invalid wake record");
  writeWakeAtomic(pendingFile(paths, wake.id), wake);
}

function quarantine(paths: WakePaths, source: string): void {
  const base = path.basename(source).replace(/[^A-Za-z0-9._-]/g, "_");
  const prefix = path.join(paths.quarantine, `${Date.now()}-${base}`);
  let destination = prefix;
  for (let suffix = 1; fs.existsSync(destination); suffix++) destination = `${prefix}-${suffix}`;
  try {
    fs.renameSync(source, destination);
    const moved = fs.lstatSync(destination);
    if (moved.isFile() && !moved.isSymbolicLink()) fs.chmodSync(destination, 0o600);
    syncDirectory(paths.quarantine);
    syncDirectory(path.dirname(source));
  } catch {
    // Leave it in place if quarantine itself fails. It remains ignored and can
    // be retried/inspected on the next startup; never delete an unread record.
  }
}

export function loadWakes(paths: WakePaths): WakeRecord[] {
  ensureWakeDirs(paths);
  const records: WakeRecord[] = [];
  for (const name of fs.readdirSync(paths.pending).sort()) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(paths.pending, name);
    let parsed: unknown;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe record");
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      quarantine(paths, file);
      continue;
    }
    if (!validWake(parsed) || name !== `${parsed.id}.json`) {
      quarantine(paths, file);
      continue;
    }
    fs.chmodSync(file, 0o600);
    records.push(parsed);
  }
  return records.sort((a, b) => a.fireAt - b.fireAt || a.id.localeCompare(b.id));
}

function safeLegacyDirectory(directory: string): boolean {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  try {
    for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) return false;
    }
    return fs.lstatSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

type LegacyRecord = { wake: WakeRecord; stat: fs.Stats };

function readLegacyRecord(file: string, expectedName: string): LegacyRecord | undefined {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) return undefined;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino
      || stat.size > MAX_RECORD_BYTES) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!validWake(parsed) || expectedName !== `${parsed.id}.json`) return undefined;
    return { wake: parsed, stat };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

type InstallResult = "installed" | "equal" | "collision";

/** Durably publish without rename-overwrite. link(2) is the atomic no-replace
 * step; the temporary inode is already fsynced and mode 0600. */
function installWakeNoReplace(file: string, wake: WakeRecord): InstallResult {
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(wake)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(temporary, file);
      syncDirectory(directory);
      return "installed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) return "collision";
        const existing: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        return validWake(existing) && JSON.stringify(existing) === JSON.stringify(wake) ? "equal" : "collision";
      } catch {
        return "collision";
      }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
      syncDirectory(directory);
    } catch { /* absent, or harmless stale temp retried by operator cleanup */ }
  }
}

function removeCopiedLegacy(file: string, original: fs.Stats): void {
  try {
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== original.dev || current.ino !== original.ino) return;
    fs.unlinkSync(file);
    syncDirectory(path.dirname(file));
  } catch {
    // The canonical copy is already durable. A retained source is safe: the
    // canonical fired journal/collision rules make the next ingestion a no-op.
  }
}

function canonicalClaim(paths: WakePaths, id: string): boolean {
  try {
    const stat = fs.lstatSync(path.join(paths.fired, `${id}.json`));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch { return false; }
}

/** One-release ingestion for stores accidentally derived as presence/wakes or
 * pi/wakes. Valid claims are copied before pending records. Sources are removed
 * only after an fsynced canonical install (or byte-equivalent destination), so
 * interruption is retryable. Divergent collisions and every malformed or
 * unsafe source remain untouched for inspection. */
export function migrateLegacyWakes(paths: WakePaths, legacyRoots: readonly string[]): void {
  ensureWakeDirs(paths);
  const roots = [...new Set(legacyRoots.map((root) => path.resolve(root)))]
    .filter((root) => root !== path.resolve(paths.root));

  for (const kind of ["fired", "pending"] as const) {
    for (const root of roots) {
      const directory = path.join(root, kind);
      if (!safeLegacyDirectory(root) || !safeLegacyDirectory(directory)) continue;
      let names: string[];
      try { names = fs.readdirSync(directory).sort(); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const source = path.join(directory, name);
        const record = readLegacyRecord(source, name);
        if (!record) continue;
        if (kind === "pending" && canonicalClaim(paths, record.wake.id)) {
          removeCopiedLegacy(source, record.stat);
          continue;
        }
        const destination = path.join(paths[kind], name);
        let result: InstallResult;
        try { result = installWakeNoReplace(destination, record.wake); }
        catch { continue; }
        if (result !== "collision") removeCopiedLegacy(source, record.stat);
      }
    }
  }
}

/** Atomically claim a wake before delivery. A restart treats anything in fired/
 * as already delivered, preventing duplicate sends. This deliberately creates
 * a tiny at-most-once boundary: a crash after this rename but before send can
 * lose one wake; Pi exposes no acknowledgement for sendMessage with which to
 * close that gap exactly-once. */
export function claimWake(paths: WakePaths, wake: WakeRecord): boolean {
  const source = pendingFile(paths, wake.id);
  const destination = path.join(paths.fired, `${wake.id}.json`);
  try {
    fs.renameSync(source, destination);
    fs.chmodSync(destination, 0o600);
    syncDirectory(paths.pending);
    syncDirectory(paths.fired);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw error;
  }
}

export function removePendingWake(paths: WakePaths, id: string): void {
  try {
    fs.unlinkSync(pendingFile(paths, id));
    syncDirectory(paths.pending);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Fired claims are an idempotence journal. Keep them across restarts; they are
 * tiny and make an old pending copy/restore with the same id harmless. */
export function wasClaimed(paths: WakePaths, id: string): boolean {
  if (!ID_RE.test(id)) return true;
  try {
    const stat = fs.lstatSync(path.join(paths.fired, `${id}.json`));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch { return false; }
}
