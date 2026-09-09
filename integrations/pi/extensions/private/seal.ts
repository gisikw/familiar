/* ============================================================================
 * Sealing — age(1) envelope encryption
 * ============================================================================
 *
 * All cryptography here is delegated to two established implementations:
 *
 *   - filippo.io/age for message sealing (X25519 + ChaCha20-Poly1305, via the
 *     `age` binary). Nothing in this file implements a cipher, a mode, a KDF,
 *     or a protocol.
 *   - Node's OpenSSL bindings (scrypt + AES-256-GCM) for wrapping the age
 *     identity under a passphrase — the same construction age's own passphrase
 *     mode uses, chosen because `age -p` can only read a passphrase from a tty
 *     and Pi owns the terminal.
 *
 * The key property this file preserves is that plaintext never touches the
 * filesystem. Sealing writes plaintext to a pipe. Opening writes *ciphertext*
 * to a private temp file (harmless) and streams the identity in on stdin,
 * because `age` cannot take both its identity and its input on stdin. No
 * argument vector ever contains plaintext or key material.
 */

import { spawn } from "node:child_process";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Binary name, overridable so a Nix-pinned age can be injected. */
const AGE = process.env.FAMILIAR_AGE_BIN || "age";
const AGE_KEYGEN = process.env.FAMILIAR_AGE_KEYGEN_BIN || "age-keygen";

interface RunResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly code: number | null;
}

function run(command: string, args: readonly string[], stdin?: Uint8Array): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString().trim(), code }),
    );
    child.stdin.on("error", () => { /* age may exit before draining stdin */ });
    child.stdin.end(stdin ?? Buffer.alloc(0));
  });
}

export class SealError extends Error {}

/** Seal bytes to a recipient. Requires only the public key: no unlock needed. */
export async function seal(recipient: string, plaintext: Uint8Array): Promise<Buffer> {
  assertRecipient(recipient);
  const result = await run(AGE, ["--encrypt", "--recipient", recipient], plaintext);
  if (result.code !== 0) throw new SealError(`age encrypt failed: ${result.stderr || result.code}`);
  return result.stdout;
}

/**
 * Open ciphertext with an identity held in memory.
 *
 * The ciphertext is staged in a caller-owned private directory because age
 * needs a seekable input when its identity comes from stdin. The staged file is
 * ciphertext, and it is removed before this function returns.
 */
export async function open(identity: string, ciphertext: Uint8Array): Promise<Buffer> {
  const staging = await mkdtemp(join(tmpdir(), "familiar-private-"));
  const path = join(staging, "sealed.age");
  try {
    await writeFile(path, ciphertext, { mode: 0o600 });
    const result = await run(AGE, ["--decrypt", "--identity", "-", path], Buffer.from(identity, "utf8"));
    if (result.code !== 0) throw new SealError(`age decrypt failed: ${result.stderr || result.code}`);
    return result.stdout;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export interface Identity {
  readonly secret: string;
  readonly recipient: string;
}

/** Generate a fresh age identity. The secret is returned, never written. */
export async function generateIdentity(): Promise<Identity> {
  const result = await run(AGE_KEYGEN, []);
  if (result.code !== 0) throw new SealError(`age-keygen failed: ${result.stderr || result.code}`);
  const text = result.stdout.toString("utf8");
  const secret = text.match(/AGE-SECRET-KEY-1[A-Z0-9]+/)?.[0];
  const recipient = (text + result.stderr).match(/age1[a-z0-9]{50,}/)?.[0];
  if (!secret || !recipient) throw new SealError("age-keygen produced an unrecognized identity");
  return { secret, recipient };
}

function assertRecipient(recipient: string): void {
  if (!/^age1[a-z0-9]{50,}$/.test(recipient)) throw new SealError("invalid age recipient");
}

/* --- passphrase-wrapped identity ------------------------------------------ */

/**
 * scrypt parameters. N=2^17 with r=8 needs ~134 MiB, which is deliberately
 * expensive for an offline guesser and unremarkable for one interactive unlock.
 */
export const KDF = { name: "scrypt", N: 1 << 17, r: 8, p: 1 } as const;
const MAXMEM = 320 * 1024 * 1024;

export interface Keyring {
  readonly v: 1;
  /** Public. Sealing works from this alone, locked or not. */
  readonly recipient: string;
  readonly kdf: { readonly name: string; readonly N: number; readonly r: number; readonly p: number };
  readonly salt: string;
  readonly nonce: string;
  readonly ct: string;
  readonly tag: string;
  readonly createdAt: string;
}

/**
 * Key derivation is deliberately synchronous.
 *
 * `crypto.scrypt`'s asynchronous form is not reliably reproducible on every
 * runtime this code can be loaded into: bun 1.3 returns results that differ
 * between calls with identical inputs at these cost parameters. A derivation
 * that silently disagrees with itself surfaces as "wrong passphrase" for a
 * passphrase that was typed correctly — the worst possible failure mode for a
 * compartment with no recovery path. `scryptSync` is stable everywhere tested,
 * and one ~300 ms block during an interactive unlock is a fair price.
 */
function derive(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  assertDeterministicKdf();
  return scryptSync(passphrase.normalize("NFKC"), salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAXMEM,
  });
}

let kdfChecked = false;

/**
 * One cheap self-test per process, so a broken runtime KDF fails loudly rather
 * than as a wrong-passphrase report for a passphrase that was typed correctly.
 */
function assertDeterministicKdf(): void {
  if (kdfChecked) return;
  const salt = Buffer.alloc(16, 0x5a);
  const options = { N: 1 << 12, r: 8, p: 1, maxmem: MAXMEM };
  const first = scryptSync("familiar-private-kdf-selftest", salt, 32, options);
  const second = scryptSync("familiar-private-kdf-selftest", salt, 32, options);
  if (!first.equals(second)) {
    throw new SealError("this runtime's scrypt is non-deterministic; refusing to touch the keyring");
  }
  kdfChecked = true;
}

/**
 * Wrap an identity under a passphrase. The recipient is authenticated as
 * additional data so a keyring cannot be spliced onto a different public key.
 */
export async function wrapIdentity(identity: Identity, passphrase: string): Promise<Keyring> {
  assertRecipient(identity.recipient);
  if (passphrase.length < 8) throw new SealError("passphrase must be at least 8 characters");
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const key = derive(passphrase, salt, KDF);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(identity.recipient, "utf8"));
  const ct = Buffer.concat([cipher.update(Buffer.from(identity.secret, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  return {
    v: 1,
    recipient: identity.recipient,
    kdf: { ...KDF },
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
    createdAt: new Date().toISOString(),
  };
}

export async function unwrapIdentity(keyring: Keyring, passphrase: string): Promise<string> {
  if (keyring.v !== 1 || keyring.kdf?.name !== "scrypt") throw new SealError("unsupported keyring format");
  const salt = Buffer.from(keyring.salt, "base64");
  const key = derive(passphrase, salt, keyring.kdf);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(keyring.nonce, "base64"));
  decipher.setAAD(Buffer.from(keyring.recipient, "utf8"));
  decipher.setAuthTag(Buffer.from(keyring.tag, "base64"));
  try {
    const secret = Buffer.concat([decipher.update(Buffer.from(keyring.ct, "base64")), decipher.final()]);
    return secret.toString("utf8");
  } catch {
    throw new SealError("wrong passphrase");
  } finally {
    key.fill(0);
  }
}

/** Constant-time equality for confirmation prompts. */
export function samePassphrase(a: string, b: string): boolean {
  const left = Buffer.from(a.normalize("NFKC"), "utf8");
  const right = Buffer.from(b.normalize("NFKC"), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
