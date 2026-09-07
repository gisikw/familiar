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

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

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
  try { return fs.lstatSync(path.join(paths.fired, `${id}.json`)).isFile(); }
  catch { return false; }
}
