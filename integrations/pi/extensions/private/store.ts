/* ============================================================================
 * Keyring persistence
 * ============================================================================
 *
 * The keyring holds a public age recipient in the clear and the matching
 * identity wrapped under Kevin's passphrase. It is the only private-mode file
 * outside the session archive, and it contains no conversation content.
 *
 * The directory is created 0700 and the file 0600, written through a temp file
 * and renamed so a crash cannot leave a half-written keyring behind.
 */

import { chmod, link, lstat, mkdir, open, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Keyring } from "./seal.ts";

export function privateDir(): string {
  const configured = process.env.FAMILIAR_PRIVATE_DIR?.trim();
  if (configured) return configured;
  throw new Error("FAMILIAR_PRIVATE_DIR is not configured");
}

export function keyringPath(): string {
  return join(privateDir(), "keyring.json");
}

export async function readKeyring(): Promise<Keyring | undefined> {
  const target = keyringPath();
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("private keyring is not a regular file");
    const raw = await readFile(target, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("private keyring is corrupt");
    return parsed as Keyring;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    // Corruption must never masquerade as absence: /private setup would then
    // overwrite the only recoverable wrapped identity.
    throw new Error("private keyring is unreadable or corrupt");
  }
}

export async function writeKeyring(keyring: Keyring): Promise<void> {
  const dir = privateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const target = keyringPath();
  const staging = `${target}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(staging, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(keyring, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Hard-link publication is atomic and refuses EEXIST. Unlike rename, it
    // cannot overwrite a keyring that appeared after setup's absence check.
    await link(staging, target);
    await unlink(staging);
    const directory = await open(dir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(staging, { force: true });
    throw error;
  }
}

/**
 * Delete the live wrapped identity. This does not revoke keyring copies already
 * retained by an external backup; callers must describe that limitation.
 */
export async function destroyKeyring(): Promise<void> {
  await rm(keyringPath(), { force: true });
}
