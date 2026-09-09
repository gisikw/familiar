/* ============================================================================
 * Sealed compartment — pure structure, no I/O, no crypto, no pi
 * ============================================================================
 *
 * A private conversation lives inside the ordinary Pi session archive as a
 * sequence of `custom` entries. That is deliberate: one archive, one file, one
 * backup, no unmergeable fork. Custom entries never participate in LLM context
 * (see pi's session-format.md), so nothing here can be walked into an upstream
 * request, a compaction summary, a branch summary, or a handoff.
 *
 * What lands on disk per private message is:
 *
 *   { v, compartment, seq, bucket, ct }
 *
 * `ct` is age ciphertext. Everything semantic — role, text, timestamp, the
 * model that produced it — lives *inside* the sealed payload. The visible
 * metadata is deliberately minimal: which compartment, message ordinal, and a
 * padded size bucket. An observer with the session file learns that a private
 * conversation happened, its turn count, and its rough volume. They learn
 * nothing about its content, and they cannot tell a user turn from an
 * assistant turn.
 *
 * Framing is `<4-byte big-endian payload length><utf8 json><zero padding>`,
 * padded up to a bucket boundary so ciphertext length reveals only a bucket.
 */

export const SEALED_TYPE = "familiar-private/sealed";
export const TOMBSTONE_TYPE = "familiar-private/tombstone";
export const MARKER_TYPE = "familiar-private/marker";

/** Padding granularity. Every sealed payload rounds up to a multiple of this. */
export const BUCKET_BYTES = 1024;
/** Bound hostile/corrupt archive records before allocation or decryption. */
export const MAX_FRAMED_BYTES = 1024 * 1024;

/** Highest supported on-disk record version. */
export const RECORD_VERSION = 1;

export type SealedKind =
  /** A turn in the private conversation. */
  | "message"
  /** A locally-computed excerpt of ordinary context, carried in at entry. */
  | "public-context-import"
  /** A draft or approved rejoin payload. Private until explicitly approved. */
  | "declassification";

export interface SealedPayload {
  readonly kind: SealedKind;
  readonly role?: "user" | "assistant" | "system";
  readonly text: string;
  readonly at: number;
  /** Provenance for assistant turns. Never an upstream model, by construction. */
  readonly model?: string;
  readonly provider?: string;
  /** Set on a declassification once Kevin approved that exact literal text. */
  readonly approvedAt?: number;
}

export interface SealedRecord {
  readonly v: number;
  readonly compartment: string;
  readonly seq: number;
  readonly bucket: number;
  readonly ct: string;
}

export interface TombstoneRecord {
  readonly v: number;
  readonly compartment: string;
  /** Every seq strictly below this is forgotten and must never be displayed. */
  readonly before: number;
}

export interface MarkerRecord {
  readonly v: number;
  readonly compartment: string;
  readonly event: "open" | "close";
  readonly at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSealedRecord(value: unknown): value is SealedRecord {
  if (!isRecord(value)) return false;
  return (
    value["v"] === RECORD_VERSION &&
    typeof value["compartment"] === "string" &&
    value["compartment"].length > 0 && value["compartment"].length <= 128 &&
    Number.isSafeInteger(value["seq"]) && (value["seq"] as number) >= 0 &&
    Number.isSafeInteger(value["bucket"]) && (value["bucket"] as number) >= BUCKET_BYTES &&
    (value["bucket"] as number) <= MAX_FRAMED_BYTES && (value["bucket"] as number) % BUCKET_BYTES === 0 &&
    typeof value["ct"] === "string" && value["ct"].length <= 2 * MAX_FRAMED_BYTES
  );
}

export function isTombstoneRecord(value: unknown): value is TombstoneRecord {
  if (!isRecord(value)) return false;
  return (
    value["v"] === RECORD_VERSION &&
    typeof value["compartment"] === "string" &&
    value["compartment"].length > 0 && value["compartment"].length <= 128 &&
    Number.isSafeInteger(value["before"]) && (value["before"] as number) >= 0
  );
}

/** Bytes a payload occupies after framing and padding. */
export function bucketFor(payloadBytes: number): number {
  const framed = 4 + payloadBytes;
  return Math.ceil(framed / BUCKET_BYTES) * BUCKET_BYTES;
}

/**
 * Frame and pad a payload for sealing. The result is fixed-bucket sized so the
 * ciphertext length leaks a bucket, not a message length.
 */
export function frame(payload: SealedPayload): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const total = bucketFor(json.byteLength);
  if (total > MAX_FRAMED_BYTES) throw new Error("sealed payload is too large");
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, json.byteLength, false);
  out.set(json, 4);
  return out;
}

/** Reverse `frame`. Throws on anything that is not a well-formed payload. */
export function unframe(bytes: Uint8Array): SealedPayload {
  if (bytes.byteLength < 4) throw new Error("sealed payload is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, false);
  if (length > bytes.byteLength - 4) throw new Error("sealed payload length is out of range");
  const expected = bucketFor(length);
  if (bytes.byteLength !== expected || expected > MAX_FRAMED_BYTES) throw new Error("sealed payload has invalid padding length");
  for (const byte of bytes.subarray(4 + length)) {
    if (byte !== 0) throw new Error("sealed payload has non-zero padding");
  }
  const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, 4 + length));
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new Error("sealed payload has an invalid shape");
  const kind = parsed["kind"];
  const role = parsed["role"];
  if (
    (kind !== "message" && kind !== "public-context-import" && kind !== "declassification") ||
    typeof parsed["text"] !== "string" ||
    !Number.isSafeInteger(parsed["at"]) ||
    (role !== undefined && role !== "user" && role !== "assistant" && role !== "system") ||
    (parsed["model"] !== undefined && typeof parsed["model"] !== "string") ||
    (parsed["provider"] !== undefined && typeof parsed["provider"] !== "string") ||
    (parsed["approvedAt"] !== undefined && !Number.isSafeInteger(parsed["approvedAt"]))
  ) throw new Error("sealed payload has an invalid shape");
  return parsed as unknown as SealedPayload;
}

/** A Pi session entry, narrowed to what this module needs. */
export interface EntryLike {
  readonly type?: string;
  readonly customType?: string;
  readonly data?: unknown;
}

export interface CompartmentView {
  readonly sealed: readonly SealedRecord[];
  /** Lowest seq that is still readable, after applying tombstones. */
  readonly forgottenBefore: number;
}

/**
 * Reduce a session's entries into one compartment's readable sealed records.
 *
 * Tombstones are honored here rather than at render time so a forgotten span
 * can never be resurrected by a different display path. Duplicate seqs keep the
 * last occurrence: an append-only log replayed after a crash may repeat a seq,
 * and the later write is the one that completed.
 */
export function readCompartment(entries: readonly EntryLike[], compartment: string): CompartmentView {
  let forgottenBefore = 0;
  const bySeq = new Map<number, SealedRecord>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === TOMBSTONE_TYPE && isTombstoneRecord(entry.data)) {
      if (entry.data.compartment === compartment && entry.data.before > forgottenBefore) {
        forgottenBefore = entry.data.before;
      }
      continue;
    }
    if (entry.customType !== SEALED_TYPE || !isSealedRecord(entry.data)) continue;
    if (entry.data.compartment !== compartment) continue;
    bySeq.set(entry.data.seq, entry.data);
  }
  const sealed = [...bySeq.values()]
    .filter((record) => record.seq >= forgottenBefore)
    .sort((a, b) => a.seq - b.seq);
  return { sealed, forgottenBefore };
}

/** Every compartment id present in a session, oldest first. */
export function listCompartments(entries: readonly EntryLike[]): string[] {
  const seen: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const data = entry.data;
    if (entry.customType === SEALED_TYPE && isSealedRecord(data) && !seen.includes(data.compartment)) {
      seen.push(data.compartment);
    }
  }
  return seen;
}

/** Next sequence number to write for a compartment. */
export function nextSeq(entries: readonly EntryLike[], compartment: string): number {
  let highest = -1;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== SEALED_TYPE) continue;
    if (!isSealedRecord(entry.data) || entry.data.compartment !== compartment) continue;
    if (entry.data.seq > highest) highest = entry.data.seq;
  }
  return highest + 1;
}
