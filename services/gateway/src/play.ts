import type http from "http";
import type { Channel } from "./channels.ts";

/* --- POST /play: imp play's clip, inline in Kes's voice stream ------------
 *
 * Body = the encoded audio bytes (imp reads the file; the gateway never opens
 * a path, so this route can't be turned into a file reader). Content-Type
 * must be audio/*. X-Clip-Title labels the segment. Answers JSON:
 *   200 {"played":true,"message_id":N,"index":I}  queued after current speech
 *   200 {"played":false,"reason":"no-listener"}   nobody has the speaker on
 *   405 / 413 / 415 on misuse.
 */

export const MAX_CLIP_BYTES = 32 << 20;
const AUDIO_TYPE = /^audio\/[a-z0-9.+-]+$/;

export async function handlePlay(req: http.IncomingMessage, res: http.ServerResponse, channel: Channel) {
  const reply = (status: number, body: object) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body) + "\n");
  };
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (!AUDIO_TYPE.test(type)) return reply(415, { error: "Content-Type must be audio/*" });
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_CLIP_BYTES) return reply(413, { error: `clip over ${MAX_CLIP_BYTES} bytes` });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_CLIP_BYTES) return reply(413, { error: `clip over ${MAX_CLIP_BYTES} bytes` });
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return reply(400, { error: "empty clip" });
  let title = String(req.headers["x-clip-title"] ?? "").slice(0, 200);
  try { title = decodeURIComponent(title); } catch { /* keep raw */ }
  const out = channel.playClip(Buffer.concat(chunks), type, `[clip] ${title || "audio"}`);
  return reply(200, out.played ? out : { played: false, reason: "no-listener" });
}
