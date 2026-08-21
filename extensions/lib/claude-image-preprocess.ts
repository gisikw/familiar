// Bounded image preprocessing for synthetic Claude Code history. Pi's
// transcript stays authoritative; only a copy destined for synthetic JSONL is
// transformed. In-bounds originals are preserved, but only after a real decode.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { ContentBlock, Message } from "./claude-projection.ts";
import { decodeBase64Strict, imageDimensions, SUPPORTED_MEDIA_TYPES } from "./image-policy.ts";

export const CLAUDE_INGEST_MAX_DIMENSION = 2000;
export const CLAUDE_INGEST_FINAL_BYTES = 512_000;
export const CLAUDE_INGEST_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const CLAUDE_DECODE_MAX_PIXELS = 16_000_000;
export const CLAUDE_FFMPEG_TIMEOUT_MS = 10_000;
export const CLAUDE_PREPROCESS_TOTAL_TIMEOUT_MS = 30_000;
export const CLAUDE_IMAGE_CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_ENTRIES = 64;
const FFMPEG_MAX_BUFFER = 40 * 1024 * 1024;

export class ClaudeImagePreprocessError extends Error {
  constructor(message: string) { super(message); this.name = "ClaudeImagePreprocessError"; }
}

export interface PreprocessOptions {
  ffmpegPath?: string;
  /** May only reduce the production ceiling; useful for latency-sensitive hosts/tests. */
  ffmpegTimeoutMs?: number;
  /** Whole request/projection deadline; may only reduce the 30s ceiling. */
  totalTimeoutMs?: number;
  /** Test seam. Every invocation, including validation, is represented here. */
  run?: (input: Buffer, args: string[]) => Buffer;
  /** Internal absolute deadline shared by all images and attempts. */
  _deadline?: number;
}

type Result = { data: string; mediaType: string };
type CacheValue = Result & { retainedBytes: number };
const cache = new Map<string, CacheValue>();
let cacheBytes = 0;

// Conservative V8 accounting: strings can retain two bytes/code-unit, plus a
// fixed allowance for key, media type and Map/object bookkeeping.
function retainedBytes(key: string, value: Result): number {
  return 2 * (key.length + value.data.length + value.mediaType.length) + 256;
}
export function clearClaudeImageCache(): void { cache.clear(); cacheBytes = 0; }
export function claudeImageCacheStats(): { entries: number; retainedBytes: number } {
  return { entries: cache.size, retainedBytes: cacheBytes };
}

function detectedMediaType(buf: Buffer): string {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new ClaudeImagePreprocessError("image bytes have an unsupported or corrupt signature");
}

function hasAlpha(buf: Buffer, mt: string): boolean {
  if (mt === "image/png") return buf.length > 25 && (buf[25] === 4 || buf[25] === 6);
  if (mt === "image/webp") {
    for (let p = 12; p + 8 <= buf.length;) {
      const kind = buf.toString("ascii", p, p + 4), n = buf.readUInt32LE(p + 4);
      if (kind === "VP8X" && p + 9 <= buf.length) return !!(buf[p + 8] & 0x10);
      if (kind === "ALPH") return true;
      p += 8 + n + (n & 1);
    }
  }
  return false;
}
function isAnimated(buf: Buffer, mt: string): boolean {
  if (mt === "image/gif") {
    let p = 13, frames = 0;
    if (buf[10] & 0x80) p += 3 * (1 << ((buf[10] & 7) + 1));
    const skipSubBlocks = () => { while (p < buf.length) { const n = buf[p++]; if (!n) return true; p += n; } return false; };
    while (p < buf.length) {
      const tag = buf[p++];
      if (tag === 0x3b) break;
      if (tag === 0x21) { p++; if (!skipSubBlocks()) break; continue; }
      if (tag !== 0x2c || p + 9 > buf.length) break;
      frames++; const packed = buf[p + 8]; p += 9;
      if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
      p++; // LZW minimum code size
      if (!skipSubBlocks()) break;
      if (frames > 1) return true;
    }
  }
  if (mt === "image/webp") return buf.includes(Buffer.from("ANIM"), 12);
  return false;
}

function defaultRun(path: string, input: Buffer, args: string[], timeoutMs = CLAUDE_FFMPEG_TIMEOUT_MS): Buffer {
  const p = spawnSync(path, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
    "-filter_threads", "1", "-filter_complex_threads", "1",
    "-max_alloc", String(64 * 1024 * 1024), "-probesize", String(8 * 1024 * 1024),
    "-analyzeduration", "5000000", "-i", "pipe:0", ...args,
  ], { input, maxBuffer: FFMPEG_MAX_BUFFER, timeout: timeoutMs, killSignal: "SIGKILL" });
  if (p.error) {
    const timed = (p.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    throw new ClaudeImagePreprocessError(timed ? `image preprocessing timed out after ${timeoutMs}ms` : `cannot run image preprocessor ${path}: ${p.error.message}`);
  }
  if (p.signal) throw new ClaudeImagePreprocessError(`image preprocessor terminated by ${p.signal}`);
  if (p.status !== 0) {
    const detail = String(p.stderr ?? "").trim().slice(0, 240);
    throw new ClaudeImagePreprocessError(`image decode/encode failed${detail ? `: ${detail}` : ""}`);
  }
  return p.stdout ?? Buffer.alloc(0);
}

function transform(buf: Buffer, declared: string, opts: PreprocessOptions): Result {
  const mediaType = declared.toLowerCase();
  if (!SUPPORTED_MEDIA_TYPES.includes(mediaType as (typeof SUPPORTED_MEDIA_TYPES)[number]))
    throw new ClaudeImagePreprocessError(`unsupported image media type ${JSON.stringify(declared)}`);
  if (buf.length > CLAUDE_INGEST_MAX_SOURCE_BYTES)
    throw new ClaudeImagePreprocessError(`image is ${(buf.length / 1048576).toFixed(2)} MiB, exceeds Familiar's 32 MiB preprocessing safety bound`);
  const actual = detectedMediaType(buf);
  if (actual !== mediaType) throw new ClaudeImagePreprocessError(`image is declared ${mediaType} but its bytes are ${actual}`);
  const dims = imageDimensions(buf);
  if (!dims || dims.w < 1 || dims.h < 1) throw new ClaudeImagePreprocessError("image has corrupt or unrecognizable dimensions");
  if (dims.w > 8000 || dims.h > 8000 || dims.w * dims.h > CLAUDE_DECODE_MAX_PIXELS)
    throw new ClaudeImagePreprocessError(`image ${dims.w}x${dims.h} exceeds decode safety limits (8000px/16MP)`);
  if (isAnimated(buf, mediaType)) throw new ClaudeImagePreprocessError(`animated ${mediaType} is not supported in synthetic history (frames will not be silently discarded)`);

  const path = opts.ffmpegPath ?? process.env.FAMILIAR_FFMPEG_PATH ?? "ffmpeg";
  const operationTimeout = Math.max(1, Math.min(CLAUDE_FFMPEG_TIMEOUT_MS, opts.ffmpegTimeoutMs ?? CLAUDE_FFMPEG_TIMEOUT_MS));
  const deadline = opts._deadline ?? (Date.now() + CLAUDE_PREPROCESS_TOTAL_TIMEOUT_MS);
  const run = (input: Buffer, args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ClaudeImagePreprocessError("image request preprocessing exceeded its total work deadline");
    return opts.run ? opts.run(input, args) : defaultRun(path, input, args, Math.max(1, Math.min(operationTimeout, remaining)));
  };
  // A full decoder pass is mandatory even for byte-preserving fast paths.
  run(buf, ["-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"]);

  const overDimension = dims.w > CLAUDE_INGEST_MAX_DIMENSION || dims.h > CLAUDE_INGEST_MAX_DIMENSION;
  if (buf.length <= CLAUDE_INGEST_FINAL_BYTES && !overDimension) return { data: buf.toString("base64"), mediaType };

  const key = createHash("sha256").update("familiar.cc-image.v2\0").update(mediaType).update(buf).digest("hex");
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return { data: hit.data, mediaType: hit.mediaType }; }
  const vf = overDimension ? ["-vf", `scale=w='min(${CLAUDE_INGEST_MAX_DIMENSION},iw)':h='min(${CLAUDE_INGEST_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`] : [];
  const common = [...vf, "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-threads", "1"];
  const finish = ["-frames:v", "1", "-f", "image2pipe", "pipe:1"];
  let out: Buffer | undefined;
  const attempt = (args: string[]) => { const c = run(buf, args); if (!c.length) throw new ClaudeImagePreprocessError("image encoder produced no output"); if (c.length <= CLAUDE_INGEST_FINAL_BYTES) out = c; };

  // Deliberate bounded divergence from Claude 2.1.197: retain the original
  // family first. This avoids lossy JPEG for screenshots. If alpha cannot fit
  // losslessly, reject rather than silently flatten it.
  if (mediaType === "image/png") attempt([...common, "-c:v", "png", "-compression_level", "9", ...finish]);
  else if (mediaType === "image/webp") attempt([...common, "-c:v", "libwebp", "-quality", "80", ...finish]);
  else attempt([...common, "-c:v", "mjpeg", "-q:v", "3", ...finish]);
  if (!out && hasAlpha(buf, mediaType)) throw new ClaudeImagePreprocessError("alpha image cannot fit the 512000-byte lossless bound; refusing silent JPEG alpha loss");
  for (const q of [3, 5, 8, 12, 18, 25, 31]) if (!out) attempt([...common, "-c:v", "mjpeg", "-q:v", String(q), ...finish]);
  if (!out) attempt(["-vf", "scale=w='min(1000,iw)':h='min(1000,ih)':force_original_aspect_ratio=decrease", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-threads", "1", "-c:v", "mjpeg", "-q:v", "31", ...finish]);
  if (!out || out.length > CLAUDE_INGEST_FINAL_BYTES) throw new ClaudeImagePreprocessError(`could not compress image below ${CLAUDE_INGEST_FINAL_BYTES} bytes`);
  const outputType = detectedMediaType(out);
  const outDims = imageDimensions(out);
  if (!outDims || outDims.w > CLAUDE_INGEST_MAX_DIMENSION || outDims.h > CLAUDE_INGEST_MAX_DIMENSION) throw new ClaudeImagePreprocessError("image encoder produced invalid dimensions");
  // Decode the final output too; encoders/fakes cannot insert malformed bytes.
  run(out, ["-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"]);
  const result = { data: out.toString("base64"), mediaType: outputType };
  const bytes = retainedBytes(key, result);
  if (bytes <= CLAUDE_IMAGE_CACHE_BYTES) {
    while (cache.size && (cache.size >= CACHE_ENTRIES || cacheBytes + bytes > CLAUDE_IMAGE_CACHE_BYTES)) {
      const first = cache.keys().next().value!; cacheBytes -= cache.get(first)!.retainedBytes; cache.delete(first);
    }
    cache.set(key, { ...result, retainedBytes: bytes }); cacheBytes += bytes;
  }
  return result;
}

function preprocessBlock(c: ContentBlock, where: string, opts: PreprocessOptions): ContentBlock {
  if (c.type === "image") {
    const out = transform(decodeBase64Strict(c.imageData ?? "", where), c.imageMediaType ?? "", opts);
    return out.data === c.imageData && out.mediaType === c.imageMediaType ? c : { ...c, imageData: out.data, imageMediaType: out.mediaType };
  }
  if (c.type === "tool_result" && c.toolResultImages?.length) {
    let changed = false;
    const images = c.toolResultImages.map((im, i) => { const out = transform(decodeBase64Strict(im.data, `${where} image[${i}]`), im.mediaType, opts); changed ||= out.data !== im.data || out.mediaType !== im.mediaType; return out; });
    return changed ? { ...c, toolResultImages: images } : c;
  }
  return c;
}

export function preprocessProjectionImages(messages: Message[], opts: PreprocessOptions = {}): Message[] {
  let changed = false;
  const total = Math.max(1, Math.min(CLAUDE_PREPROCESS_TOTAL_TIMEOUT_MS, opts.totalTimeoutMs ?? CLAUDE_PREPROCESS_TOTAL_TIMEOUT_MS));
  const boundedOpts: PreprocessOptions = { ...opts, _deadline: Date.now() + total };
  const out = messages.map((m, mi) => { const content = m.content.map((c, ci) => preprocessBlock(c, `messages[${mi}].content[${ci}]`, boundedOpts)); if (content.some((c, i) => c !== m.content[i])) { changed = true; return { ...m, content }; } return m; });
  return changed ? out : messages;
}
