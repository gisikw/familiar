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

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  try {
    const raw = await readFile(keyringPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Keyring;
  } catch {
    return undefined;
  }
}

export async function writeKeyring(keyring: Keyring): Promise<void> {
  const dir = privateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = keyringPath();
  const staging = `${target}.tmp`;
  await writeFile(staging, `${JSON.stringify(keyring, null, 2)}\n`, { mode: 0o600 });
  await rename(staging, target);
}

/**
 * Crypto-erasure. Destroying the identity makes every sealed record in every
 * session archive permanently unreadable in one action, without rewriting
 * append-only session files. It is the only deletion primitive here that is
 * honest about what it guarantees.
 */
export async function destroyKeyring(): Promise<void> {
  await rm(keyringPath(), { force: true });
}
