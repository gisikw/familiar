// image-policy.ts — real Anthropic image caps + validation for the local claude
// driver. We project images as INLINE base64 (the only representation Claude
// Code 2.1.197 accepts headlessly — a local-file source {type:"file",path} is
// rejected upstream with "an image could not be processed and was removed").
// Because base64 lives inline in the projected JSONL there are NO image temp
// files to leak and NO local paths to perturb the deterministic cache prefix.
//
// Wire caps mirror Claude Code 2.1.197 / Anthropic request limits. Synthetic
// historical images are preprocessed before this policy runs; the trailing
// direct-user image may use a larger explicit source bound because Claude's
// ordinary ingestion pass resizes/re-encodes it before outbound submission.
//   • media type ∈ {png, jpeg, gif, webp}
//   • ≤ MAX_IMAGE_BYTES decoded per projected/wire image (5 MiB)
//   • ≤ MAX_IMAGES_PER_REQUEST images total across the whole request (100)
//   • ≤ MAX_DIMENSION px per side when dimensions are cheaply parseable
// Every violation throws an actionable invalid_request_error (never silently
// drops pixels).
import type { Message } from "./claude-projection.ts";

export const SUPPORTED_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic per-image hard cap
export const MAX_IMAGES_PER_REQUEST = 100; // Anthropic Messages API per-request cap
export const MAX_DIMENSION = 8000; // Anthropic max px per side
// Bounds total decoded ingress/work before preprocessing. This deliberately
// composes with loopback A's encoded-body cap rather than multiplying 32 MiB by
// the 100-image count allowance.
export const MAX_AGGREGATE_IMAGE_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_AGGREGATE_IMAGE_PIXELS = 64_000_000;

export class ImagePolicyError extends Error {
  code = "image_policy";
  constructor(message: string) {
    super(message);
    this.name = "ImagePolicyError";
  }
}

export interface ImageRef {
  data: string; // base64
  mediaType: string;
  // where it came from, for actionable error context
  where: string;
}

// decodeBase64Strict — decode + validate that the string is real base64 whose
// re-encoding round-trips (rejects truncated/garbage payloads). Returns bytes.
export function decodeBase64Strict(data: string, where: string): Buffer {
  if (!data || data.trim() === "") {
    throw new ImagePolicyError(`image at ${where} has empty base64 data`);
  }
  const cleaned = data.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    throw new ImagePolicyError(`image at ${where} is not valid base64 (contains non-base64 characters)`);
  }
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length === 0) {
    throw new ImagePolicyError(`image at ${where} decoded to zero bytes`);
  }
  // Round-trip guard: base64 of the decoded bytes (sans padding) must match the
  // cleaned input (sans padding). Catches silently-truncated payloads that
  // Buffer.from tolerates.
  const reencoded = buf.toString("base64").replace(/=+$/, "");
  if (reencoded !== cleaned.replace(/=+$/, "")) {
    throw new ImagePolicyError(`image at ${where} has malformed base64 (does not round-trip cleanly)`);
  }
  return buf;
}

// imageDimensions — best-effort width/height from the first bytes of common
// formats. Returns null when it cannot cheaply determine them (we then skip the
// dimension check rather than guess). Supports PNG and baseline/progressive JPEG.
export function imageDimensions(buf: Buffer): { w: number; h: number } | null {
  // PNG: 8-byte sig, then IHDR (width @16, height @20, big-endian)
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // GIF: "GIF8", width/height little-endian @6/@8
  if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  // WebP: RIFF/WEBP followed by VP8, VP8L, or VP8X dimensions.
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const kind = buf.toString("ascii", 12, 16);
    if (kind === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L" && buf.length >= 25) {
      const n = buf.readUInt32LE(21);
      return { w: (n & 0x3fff) + 1, h: ((n >>> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
  }
  // JPEG: scan segments for a SOF marker (0xFFC0..0xCF except C4/C8/CC)
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { off += 2; continue; }
      const segLen = buf.readUInt16BE(off + 2);
      const isSOF = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
      }
      off += 2 + segLen;
    }
  }
  return null;
}

// validateImage — validate a single image ref (media type, base64, size, dims).
// Throws ImagePolicyError on any violation.
export function validateImage(ref: ImageRef, maxBytes = MAX_IMAGE_BYTES): void {
  const mt = (ref.mediaType || "").toLowerCase();
  if (!SUPPORTED_MEDIA_TYPES.includes(mt as (typeof SUPPORTED_MEDIA_TYPES)[number])) {
    throw new ImagePolicyError(
      `image at ${ref.where} has unsupported media type ${JSON.stringify(ref.mediaType)}; supported: ${SUPPORTED_MEDIA_TYPES.join(", ")}`,
    );
  }
  const buf = decodeBase64Strict(ref.data, ref.where);
  if (buf.length > maxBytes) {
    throw new ImagePolicyError(
      `image at ${ref.where} is ${(buf.length / (1024 * 1024)).toFixed(2)} MiB, exceeds the ${(maxBytes / (1024 * 1024)).toFixed(0)} MiB per-image limit`,
    );
  }
  const dims = imageDimensions(buf);
  if (dims && (dims.w > MAX_DIMENSION || dims.h > MAX_DIMENSION)) {
    throw new ImagePolicyError(
      `image at ${ref.where} is ${dims.w}x${dims.h}px, exceeds the ${MAX_DIMENSION}px per-side limit`,
    );
  }
}

// collectImages — gather every image ref in the request (direct user image
// blocks AND image-bearing tool_result blocks), tagging each with a location
// for actionable errors.
export function collectImages(messages: Message[]): ImageRef[] {
  const refs: ImageRef[] = [];
  messages.forEach((m, mi) => {
    m.content.forEach((c, ci) => {
      if (c.type === "image" && c.imageData !== undefined) {
        refs.push({ data: c.imageData ?? "", mediaType: c.imageMediaType ?? "", where: `messages[${mi}].content[${ci}] (${m.role} image)` });
      }
      if (c.type === "tool_result" && Array.isArray(c.toolResultImages)) {
        c.toolResultImages.forEach((im, ii) => {
          refs.push({ data: im.data, mediaType: im.mediaType, where: `messages[${mi}].content[${ci}] tool_result image[${ii}]` });
        });
      }
    });
  });
  return refs;
}

// enforceImagePolicy — validate the whole request. Throws ImagePolicyError on
// the first violation (count cap, media type, size, dims, malformed base64).
export function enforceImageCount(messages: Message[]): { count: number } {
  const count = collectImages(messages).length;
  if (count > MAX_IMAGES_PER_REQUEST) {
    throw new ImagePolicyError(
      `request carries ${count} images, exceeds the ${MAX_IMAGES_PER_REQUEST}-image per-request limit`,
    );
  }
  return { count };
}

export function enforceAggregateImageSourceBytes(messages: Message[], maxBytes = MAX_AGGREGATE_IMAGE_SOURCE_BYTES, maxPixels = MAX_AGGREGATE_IMAGE_PIXELS): { count: number; bytes: number; pixels: number } {
  const refs = collectImages(messages);
  let bytes = 0, pixels = 0;
  for (const ref of refs) {
    // Check the encoded length before allocating a decoded Buffer. Four base64
    // chars represent at most three bytes; whitespace is accepted by the strict
    // decoder and already bounded by loopback A's body cap.
    const encoded = ref.data.replace(/\s+/g, "");
    const upperBound = Math.ceil(encoded.length / 4) * 3;
    if (bytes + upperBound > maxBytes + 2) {
      throw new ImagePolicyError(`aggregate image data exceeds Familiar's ${(maxBytes / 1048576).toFixed(0)} MiB request work limit at ${ref.where}`);
    }
    const decoded = decodeBase64Strict(ref.data, ref.where);
    bytes += decoded.length;
    if (bytes > maxBytes) {
      throw new ImagePolicyError(`aggregate image data exceeds Familiar's ${(maxBytes / 1048576).toFixed(0)} MiB request work limit at ${ref.where}`);
    }
    const dims = imageDimensions(decoded);
    if (dims) pixels += dims.w * dims.h;
    if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
      throw new ImagePolicyError(`aggregate decoded image area exceeds Familiar's ${maxPixels / 1_000_000} MP request work limit at ${ref.where}`);
    }
  }
  return { count: refs.length, bytes, pixels };
}

export function enforceImagePolicy(messages: Message[], opts: { maxImageBytes?: number } = {}): { count: number } {
  const refs = collectImages(messages);
  enforceImageCount(messages);
  for (const ref of refs) validateImage(ref, opts.maxImageBytes ?? MAX_IMAGE_BYTES);
  return { count: refs.length };
}
