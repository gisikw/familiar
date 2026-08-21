// Deterministic image preprocessing for synthetic Claude Code history.
//
// Claude Code 2.1.197 preprocesses ordinary/current images at ingestion, but
// images loaded from a synthetic --resume JSONL bypass that pass. Familiar's pi
// transcript remains authoritative (we transform a projection copy only).
// ffmpeg is supplied by Familiar's pinned Nix shell; no native npm addon is
// loaded into pi. Outputs are deterministic for that pinned binary.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { ContentBlock, Message } from "./claude-projection.ts";
import { decodeBase64Strict, imageDimensions, SUPPORTED_MEDIA_TYPES } from "./image-policy.ts";

export const CLAUDE_INGEST_MAX_DIMENSION = 2000;
export const CLAUDE_INGEST_FINAL_BYTES = 512_000;
export const CLAUDE_INGEST_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const CACHE_ENTRIES = 64; // transformed bytes are <=512k: <=~31.25 MiB

export class ClaudeImagePreprocessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeImagePreprocessError";
  }
}

export interface PreprocessOptions {
  ffmpegPath?: string;
  run?: (input: Buffer, args: string[]) => Buffer;
}

const cache = new Map<string, { data: string; mediaType: string }>();

function detectedMediaType(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new ClaudeImagePreprocessError("image preprocessor produced an unsupported format");
}

function defaultRun(path: string, input: Buffer, args: string[]): Buffer {
  const p = spawnSync(path, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...args, "-frames:v", "1", "-f", "image2pipe", "pipe:1"], {
    input,
    maxBuffer: 40 * 1024 * 1024,
  });
  if (p.error) throw new ClaudeImagePreprocessError(`cannot run image preprocessor ${path}: ${p.error.message}`);
  if (p.status !== 0 || !p.stdout?.length) {
    const detail = String(p.stderr ?? "").trim().slice(0, 240);
    throw new ClaudeImagePreprocessError(`image preprocessing failed${detail ? `: ${detail}` : ""}`);
  }
  return p.stdout;
}

function transform(buf: Buffer, mediaType: string, opts: PreprocessOptions): { data: string; mediaType: string } {
  if (!SUPPORTED_MEDIA_TYPES.includes(mediaType.toLowerCase() as (typeof SUPPORTED_MEDIA_TYPES)[number])) {
    throw new ClaudeImagePreprocessError(`unsupported image media type ${JSON.stringify(mediaType)}`);
  }
  if (buf.length > CLAUDE_INGEST_MAX_SOURCE_BYTES) {
    throw new ClaudeImagePreprocessError(`image is ${(buf.length / 1048576).toFixed(2)} MiB, exceeds Familiar's 32 MiB preprocessing safety bound`);
  }
  const dims = imageDimensions(buf);
  const overDimension = !!dims && (dims.w > CLAUDE_INGEST_MAX_DIMENSION || dims.h > CLAUDE_INGEST_MAX_DIMENSION);
  if (buf.length <= CLAUDE_INGEST_FINAL_BYTES && !overDimension) return { data: buf.toString("base64"), mediaType };

  const key = createHash("sha256").update("familiar.cc-image.v1\0").update(mediaType).update(buf).digest("hex");
  const hit = cache.get(key);
  if (hit) return hit;

  const path = opts.ffmpegPath ?? process.env.FAMILIAR_FFMPEG_PATH ?? "ffmpeg";
  const run = opts.run ?? ((input, args) => defaultRun(path, input, args));
  const vf = overDimension
    ? ["-vf", `scale=w='min(${CLAUDE_INGEST_MAX_DIMENSION},iw)':h='min(${CLAUDE_INGEST_MAX_DIMENSION},ih)':force_original_aspect_ratio=decrease`]
    : [];
  const common = [...vf, "-map_metadata", "-1"];
  let out: Buffer | undefined;
  const tryOutput = (args: string[]) => {
    const candidate = run(buf, args);
    if (candidate.length <= CLAUDE_INGEST_FINAL_BYTES) out = candidate;
  };

  // Claude first tries the original family (notably PNG screenshots), then
  // falls back through lossy JPEG qualities to a <=500 KiB final wire image.
  if (mediaType === "image/png") tryOutput([...common, "-c:v", "png", "-compression_level", "9"]);
  else if (mediaType === "image/webp") tryOutput([...common, "-c:v", "libwebp", "-quality", "80"]);
  else tryOutput([...common, "-c:v", "mjpeg", "-q:v", "3"]);

  for (const q of [3, 5, 8, 12, 18, 25, 31]) {
    if (out) break;
    tryOutput([...common, "-c:v", "mjpeg", "-q:v", String(q)]);
  }
  if (!out) {
    out = run(buf, ["-vf", "scale=w='min(1000,iw)':h='min(1000,ih)':force_original_aspect_ratio=decrease", "-map_metadata", "-1", "-c:v", "mjpeg", "-q:v", "31"]);
  }
  if (out.length > CLAUDE_INGEST_FINAL_BYTES) {
    throw new ClaudeImagePreprocessError(`could not compress image below ${CLAUDE_INGEST_FINAL_BYTES} bytes`);
  }
  const result = { data: out.toString("base64"), mediaType: detectedMediaType(out) };
  cache.set(key, result);
  if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  return result;
}

function preprocessBlock(c: ContentBlock, where: string, opts: PreprocessOptions): ContentBlock {
  if (c.type === "image") {
    const buf = decodeBase64Strict(c.imageData ?? "", where);
    const out = transform(buf, c.imageMediaType ?? "", opts);
    if (out.data === c.imageData && out.mediaType === c.imageMediaType) return c;
    return { ...c, imageData: out.data, imageMediaType: out.mediaType };
  }
  if (c.type === "tool_result" && c.toolResultImages?.length) {
    let changed = false;
    const images = c.toolResultImages.map((im, i) => {
      const buf = decodeBase64Strict(im.data, `${where} image[${i}]`);
      const out = transform(buf, im.mediaType, opts);
      if (out.data !== im.data || out.mediaType !== im.mediaType) changed = true;
      return out;
    });
    return changed ? { ...c, toolResultImages: images } : c;
  }
  return c;
}

// Process only messages that will enter synthetic JSONL. The trailing direct
// user image is deliberately excluded: Claude Code's real ingestion path will
// process it and add its original/display-dimension context itself.
export function preprocessProjectionImages(messages: Message[], opts: PreprocessOptions = {}): Message[] {
  let changed = false;
  const out = messages.map((m, mi) => {
    const content = m.content.map((c, ci) => preprocessBlock(c, `messages[${mi}].content[${ci}]`, opts));
    if (content.some((c, i) => c !== m.content[i])) { changed = true; return { ...m, content }; }
    return m;
  });
  return changed ? out : messages;
}
