// image-policy.test.ts — unit tests for the image policy + projection of
// images (direct user blocks and image-bearing tool_results). Run:
//   nix develop .#stt -c bun test extensions/lib/image-policy.test.ts
import { expect, test, describe } from "bun:test";
import * as zlib from "node:zlib";
import {
  enforceImagePolicy,
  validateImage,
  decodeBase64Strict,
  imageDimensions,
  collectImages,
  ImagePolicyError,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_REQUEST,
} from "./image-policy.ts";
import { parseAnthropicBody } from "./anthropic-body.ts";
import { projectClaudeCodeJSONL, type Message, type ProjectionOptions } from "./claude-projection.ts";

// ---- tiny valid image generators (no external deps) -------------------------
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
export function makePng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[1 + x * 3 + 1] = rgb[1]; row[1 + x * 3 + 2] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}
// Minimal baseline JPEG carrying a SOF0 with a known WxH (header-only; enough
// for dimension parsing + media-type/base64 validation).
function makeJpeg(w: number, h: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const sof = Buffer.alloc(2 + 2 + 6 + 3);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(8 + 3, 2);
  sof[4] = 8; sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof[9] = 1; sof[10] = 0x11; sof[11] = 0;
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, sof, eoi]);
}

const PNG = makePng(16, 16, [10, 20, 250]);
const PNG_B64 = PNG.toString("base64");
const JPEG = makeJpeg(24, 32);
const JPEG_B64 = JPEG.toString("base64");

const OPTS: ProjectionOptions = { sessionId: "55555555-5555-5555-8555-555555555555", cwd: "/tmp/x" };

describe("decodeBase64Strict", () => {
  test("valid PNG base64 decodes", () => {
    expect(decodeBase64Strict(PNG_B64, "x").length).toBe(PNG.length);
  });
  test("empty throws", () => expect(() => decodeBase64Strict("", "x")).toThrow(ImagePolicyError));
  test("non-base64 chars throw", () => expect(() => decodeBase64Strict("not valid!!@@", "x")).toThrow(/not valid base64/));
  test("malformed / non-roundtrip throws", () => {
    // A string that Buffer.from tolerates but does not round-trip.
    expect(() => decodeBase64Strict("AAAAA", "x")).toThrow(/round-trip|not valid base64/);
  });
  test("whitespace tolerated (data-URI-style wrapping)", () => {
    const wrapped = PNG_B64.replace(/(.{4})/g, "$1\n");
    expect(decodeBase64Strict(wrapped, "x").length).toBe(PNG.length);
  });
});

describe("imageDimensions", () => {
  test("PNG dims", () => expect(imageDimensions(PNG)).toEqual({ w: 16, h: 16 }));
  test("JPEG dims", () => expect(imageDimensions(JPEG)).toEqual({ w: 24, h: 32 }));
  test("unknown → null", () => expect(imageDimensions(Buffer.from([1, 2, 3, 4]))).toBeNull());
});

describe("validateImage", () => {
  test("valid PNG passes", () => expect(() => validateImage({ data: PNG_B64, mediaType: "image/png", where: "t" })).not.toThrow());
  test("valid JPEG passes", () => expect(() => validateImage({ data: JPEG_B64, mediaType: "image/jpeg", where: "t" })).not.toThrow());
  test("unsupported media type throws actionable", () => {
    expect(() => validateImage({ data: PNG_B64, mediaType: "image/tiff", where: "here" })).toThrow(/unsupported media type.*here|here.*unsupported/);
  });
  test("oversize throws", () => {
    // fabricate a base64 string that decodes to > MAX_IMAGE_BYTES without huge cost
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1024, 0x41);
    // give it a PNG header so media-type check passes; size check should still fire
    big.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    expect(() => validateImage({ data: big.toString("base64"), mediaType: "image/png", where: "big" })).toThrow(/exceeds the 5 MiB per-image/);
  });
  test("oversize dimensions throws", () => {
    const wide = makePng(1, 1, [0, 0, 0]);
    wide.writeUInt32BE(9000, 16); wide.writeUInt32BE(9000, 20); // lie about IHDR dims
    expect(() => validateImage({ data: wide.toString("base64"), mediaType: "image/png", where: "wide" })).toThrow(/per-side limit/);
  });
});

describe("collectImages + enforceImagePolicy", () => {
  test("collects direct user images AND tool_result images", () => {
    const messages: Message[] = [
      { id: "u", role: "user", content: [{ type: "image", imageData: PNG_B64, imageMediaType: "image/png" }, { type: "text", text: "hi" }] },
      { id: "t", role: "tool", content: [{ type: "tool_result", toolResultFor: "toolu_1", toolOutput: "", toolResultImages: [{ data: JPEG_B64, mediaType: "image/jpeg" }] }] },
    ];
    const refs = collectImages(messages);
    expect(refs).toHaveLength(2);
    expect(refs[0].where).toContain("user image");
    expect(refs[1].where).toContain("tool_result image");
    expect(enforceImagePolicy(messages)).toEqual({ count: 2 });
  });

  test("multiple images all validated", () => {
    const messages: Message[] = [
      { id: "u", role: "user", content: [
        { type: "image", imageData: PNG_B64, imageMediaType: "image/png" },
        { type: "image", imageData: JPEG_B64, imageMediaType: "image/jpeg" },
        { type: "text", text: "compare" },
      ] },
    ];
    expect(enforceImagePolicy(messages)).toEqual({ count: 2 });
  });

  test("too many images throws count cap", () => {
    const many: Message[] = [{ id: "u", role: "user", content: Array.from({ length: MAX_IMAGES_PER_REQUEST + 1 }, () => ({ type: "image" as const, imageData: PNG_B64, imageMediaType: "image/png" })) }];
    expect(() => enforceImagePolicy(many)).toThrow(/exceeds the 100-image per-request/);
  });

  test("malformed image in a tool_result surfaces an actionable error", () => {
    const messages: Message[] = [
      { id: "t", role: "tool", content: [{ type: "tool_result", toolResultFor: "toolu_1", toolOutput: "", toolResultImages: [{ data: "@@@notbase64@@@", mediaType: "image/png" }] }] },
    ];
    expect(() => enforceImagePolicy(messages)).toThrow(/tool_result image/);
  });
});

describe("projection of images (inline base64, deterministic)", () => {
  test("direct user image projects as base64 source block", () => {
    const messages: Message[] = [
      { id: "u1", createdAt: "2026-06-20T15:30:00Z", role: "user", content: [
        { type: "image", imageData: PNG_B64, imageMediaType: "image/png" },
        { type: "text", text: "what color?" },
      ] },
    ];
    const jsonl = projectClaudeCodeJSONL(messages, OPTS);
    const row = JSON.parse(jsonl.trim());
    expect(row.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
      { type: "text", text: "what color?" },
    ]);
  });

  test("image-bearing tool_result projects text+image array + isImage flag", () => {
    const messages: Message[] = [
      { id: "a1", createdAt: "2026-06-20T15:30:00Z", role: "assistant", content: [{ type: "tool_use", toolUseId: "toolu_1", toolName: "read", toolInput: { path: "shot.png" } }] },
      { id: "t1", parentId: "a1", createdAt: "2026-06-20T15:30:01Z", role: "tool", content: [
        { type: "tool_result", toolResultFor: "toolu_1", toolOutput: "screenshot captured", toolResultImages: [{ data: PNG_B64, mediaType: "image/png" }] },
      ] },
    ];
    const rows = projectClaudeCodeJSONL(messages, OPTS).trim().split("\n").map((l) => JSON.parse(l));
    const tr = rows[1].message.content[0];
    expect(tr.type).toBe("tool_result");
    expect(tr.content).toEqual([
      { type: "text", text: "screenshot captured" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
    ]);
    expect(rows[1].toolUseResult.isImage).toBe(true);
    expect(rows[1].sourceToolAssistantUUID).toBe(rows[0].uuid);
  });

  test("image-only tool_result (no text) projects just the image block", () => {
    const messages: Message[] = [
      { id: "a1", createdAt: "2026-06-20T15:30:00Z", role: "assistant", content: [{ type: "tool_use", toolUseId: "toolu_1", toolName: "screenshot", toolInput: {} }] },
      { id: "t1", parentId: "a1", createdAt: "2026-06-20T15:30:01Z", role: "tool", content: [
        { type: "tool_result", toolResultFor: "toolu_1", toolOutput: "", toolResultImages: [{ data: PNG_B64, mediaType: "image/png" }] },
      ] },
    ];
    const rows = projectClaudeCodeJSONL(messages, OPTS).trim().split("\n").map((l) => JSON.parse(l));
    expect(rows[1].message.content[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
    ]);
  });

  test("deterministic: same image input → identical projected bytes", () => {
    const messages: Message[] = [
      { id: "u1", createdAt: "2026-06-20T15:30:00Z", role: "user", content: [{ type: "image", imageData: PNG_B64, imageMediaType: "image/png" }, { type: "text", text: "x" }] },
    ];
    expect(projectClaudeCodeJSONL(messages, OPTS)).toBe(projectClaudeCodeJSONL(messages, OPTS));
  });
});

describe("anthropic-body → image extraction", () => {
  test("direct user image block parsed to imageData/imageMediaType", () => {
    const p = parseAnthropicBody({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }, { type: "text", text: "?" }] }] });
    expect(p.messages[0].content[0]).toMatchObject({ type: "image", imageData: PNG_B64, imageMediaType: "image/png" });
  });

  test("image-bearing tool_result → toolResultImages extracted, text preserved", () => {
    const p = parseAnthropicBody({ messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "here" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }] },
    ] }] });
    expect(p.messages[0].role).toBe("tool");
    const tr = p.messages[0].content[0];
    expect(tr.toolOutput).toBe("here");
    expect(tr.toolResultImages).toEqual([{ data: PNG_B64, mediaType: "image/png" }]);
  });

  test("image-only tool_result → empty text output, image extracted", () => {
    const p = parseAnthropicBody({ messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }] },
    ] }] });
    const tr = p.messages[0].content[0];
    expect(tr.toolOutput).toBe("");
    expect(tr.toolResultImages).toEqual([{ data: PNG_B64, mediaType: "image/png" }]);
  });
});
