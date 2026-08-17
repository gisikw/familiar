// Minimal STT HTTP shim over transcribe.cpp's transcribe-cli.
// transcribe.cpp is a library/CLI by design (no server example), so this
// provides an OpenAI-ish /v1/audio/transcriptions endpoint for familiar.
//
// Env: STT_MODEL (path to .gguf, required), PORT (default 9932)

import { unlink } from "fs/promises";
import { tmpdir } from "os";

const MODEL = process.env.STT_MODEL;
const PORT = Number(process.env.PORT ?? 9932);
if (!MODEL) {
  console.error("STT_MODEL not set");
  process.exit(1);
}

async function run(cmd: string[], stdin?: Blob): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

async function transcribe(audio: Blob): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const wav = `${tmpdir()}/stt-${stamp}.wav`;
  const txt = `${tmpdir()}/stt-${stamp}.txt`;
  try {
    // Normalize whatever arrived (webm/opus/m4a/wav) to 16 kHz mono WAV,
    // which transcribe-cli requires.
    const ff = await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "wav", "-y", wav], audio);
    if (ff.code !== 0) throw new Error(`ffmpeg: ${ff.err.trim()}`);
    // -o writes only the transcribed text; stdout carries diagnostics we discard.
    const tc = await run(["transcribe-cli", "-m", MODEL, "-q", "--timestamps", "none", "-o", txt, wav]);
    if (tc.code !== 0) throw new Error(`transcribe-cli: ${tc.err.trim()}`);
    return (await Bun.file(txt).text()).trim();
  } finally {
    await unlink(wav).catch(() => {});
    await unlink(txt).catch(() => {});
  }
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    try {
      let audio: Blob | null = null;
      const contentType = req.headers.get("content-type") ?? "";
      if (contentType.includes("multipart/form-data")) {
        // OpenAI-style: multipart with a "file" field.
        const form = await req.formData();
        const file = form.get("file");
        if (file instanceof Blob) audio = file;
      } else {
        // Raw audio body.
        audio = await req.blob();
      }
      if (!audio || audio.size === 0) return Response.json({ error: "no audio provided" }, { status: 400 });

      const text = await transcribe(audio);
      return Response.json({ text });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  },
});

console.log(`stt-server listening on 127.0.0.1:${PORT} (model: ${MODEL})`);
