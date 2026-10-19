import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// YouTube links through fetch: captions, not the page.
//
// The watch page is a JS app; converting its HTML yields nothing worth
// reading. So a YouTube URL is recognized up front and its captions are
// pulled with yt-dlp (the one outside dependency we accept for this, see
// notes/2026-10-18-youtube-podcast-ingest.md in the Kestrel instance). The
// full transcript is written to a cache file keyed by video id; fetch returns
// the same 50KB-bounded view it gives any page, plus the path, so the agent
// can read the rest (or hand it to something else) later.
//
// Binary: FAMILIAR_YTDLP_BIN (absolute path, set by the pi devshell from
// nixpkgs-unstable) or `yt-dlp` on PATH. Captions only: no media download,
// so deno/JS-challenge solving isn't needed. Ask for exactly en,en-orig:
// "en.*" also matches translated tracks and trips YouTube's 429.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YTDLP_TIMEOUT_MS = 90_000;
const DESCRIPTION_MAX_CHARS = 1500;
const MARK_EVERY_SECONDS = 60;

export function youtubeVideoId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const m = url.pathname.match(/^\/(?:shorts|live|embed|v|e)\/([^/?#]+)/);
      if (m) id = m[1];
    }
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

export type Cue = { start: number; text: string };

const vttTime = (s: string): number => {
  const parts = s.trim().split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
};

const decodeBasicEntities = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");

// WebVTT → ordered caption lines. YouTube's auto-captions "roll": each cue
// repeats the previous line above the new one (plus a 10ms echo cue), so a
// line is kept only if it differs from the last kept line.
export function parseVtt(vtt: string): Cue[] {
  const out: Cue[] = [];
  const blocks = vtt.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const start = vttTime(lines[ti].split("-->")[0]);
    for (const raw of lines.slice(ti + 1)) {
      const text = decodeBasicEntities(raw.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (out.length && out[out.length - 1].text === text) continue;
      out.push({ start, text });
    }
  }
  return out;
}

export const clock = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

// Paragraphs of running text with a [m:ss] mark roughly once a minute, so a
// reader can say "around 20:00 he argues…" without a timestamp per line.
export function transcriptText(cues: Cue[]): string {
  const paras: string[] = [];
  let cur: string[] = [];
  let mark = -Infinity;
  for (const c of cues) {
    if (c.start - mark >= MARK_EVERY_SECONDS) {
      if (cur.length) paras.push(cur.join(" "));
      cur = [`[${clock(c.start)}]`];
      mark = c.start;
    }
    cur.push(c.text);
  }
  if (cur.length) paras.push(cur.join(" "));
  return paras.join("\n\n");
}

export type VideoInfo = {
  id: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  upload_date?: string;
  description?: string;
  chapters?: { start_time: number; title: string }[];
};

export function renderTranscript(
  info: VideoInfo,
  url: string,
  captions: { kind: "manual" | "auto"; lang: string; cues: Cue[] } | null,
): string {
  const meta = [
    info.channel || info.uploader,
    info.duration ? clock(info.duration) : undefined,
    info.upload_date ? info.upload_date.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") : undefined,
    url,
  ].filter(Boolean).join(" · ");
  const parts = [`# ${info.title ?? info.id}`, meta];
  if (captions) parts.push(`Captions: ${captions.kind === "manual" ? "uploaded" : "auto-generated"} (${captions.lang})`);
  if (info.description?.trim()) {
    const d = info.description.trim();
    parts.push(`## Description\n\n${d.length > DESCRIPTION_MAX_CHARS ? d.slice(0, DESCRIPTION_MAX_CHARS) + "…" : d}`);
  }
  if (info.chapters?.length) {
    parts.push(`## Chapters\n\n${info.chapters.map((c) => `- [${clock(c.start_time)}] ${c.title}`).join("\n")}`);
  }
  parts.push(
    captions && captions.cues.length
      ? `## Transcript\n\n${transcriptText(captions.cues)}`
      : "## Transcript\n\n_No English captions on this video. (Audio transcription through Parakeet isn't wired into fetch yet.)_",
  );
  return parts.join("\n\n") + "\n";
}

const run = (bin: string, args: string[], signal?: AbortSignal): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { signal, timeout: YTDLP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || err.message).trim().split("\n").slice(-3).join(" | ");
          reject(new Error(`yt-dlp failed: ${tail}`));
        } else resolve(stdout);
      },
    );
  });

export const transcriptCacheDir = (): string =>
  join(process.env.FAMILIAR_STATE_DIR || join(tmpdir(), "familiar"), "transcripts", "youtube");

// Returns the full transcript markdown and the file it lives in. A cached
// file is reused as-is; delete it to force a refetch.
export async function youtubeTranscript(id: string, signal?: AbortSignal): Promise<{ path: string | null; markdown: string; cached: boolean }> {
  const dir = transcriptCacheDir();
  const path = join(dir, `${id}.md`);
  const existing = await readFile(path, "utf8").catch(() => null);
  if (existing) return { path, markdown: existing, cached: true };

  const bin = process.env.FAMILIAR_YTDLP_BIN || "yt-dlp";
  const url = `https://www.youtube.com/watch?v=${id}`;
  const work = await mkdtemp(join(tmpdir(), "familiar-yt-"));
  try {
    await run(bin, [
      "--skip-download", "--no-playlist", "--no-warnings", "--ignore-config",
      "--write-info-json", "--no-write-comments",
      "--write-subs", "--write-auto-subs", "--sub-langs", "en,en-orig", "--sub-format", "vtt",
      "-o", join(work, "%(id)s.%(ext)s"),
      url,
    ], signal);
    const files = await readdir(work);
    const infoFile = files.find((f) => f.endsWith(".info.json"));
    const info: VideoInfo = infoFile ? JSON.parse(await readFile(join(work, infoFile), "utf8")) : { id };
    const manual = new Set(Object.keys((info as { subtitles?: Record<string, unknown> }).subtitles ?? {}));
    // Prefer an uploaded track, then the auto "en", then the auto original.
    const vtts = files.filter((f) => f.endsWith(".vtt"));
    const langOf = (f: string) => f.slice(id.length + 1, -".vtt".length);
    const ranked = vtts.sort((a, b) => score(langOf(b), manual) - score(langOf(a), manual));
    let captions: { kind: "manual" | "auto"; lang: string; cues: Cue[] } | null = null;
    if (ranked.length) {
      const lang = langOf(ranked[0]);
      captions = { kind: manual.has(lang) ? "manual" : "auto", lang, cues: parseVtt(await readFile(join(work, ranked[0]), "utf8")) };
    }
    const markdown = renderTranscript(info, url, captions);
    await mkdir(dir, { recursive: true });
    // Only cache when there's a transcript; a captionless result may be a
    // transient fetch problem, and the metadata alone is cheap to redo.
    if (!captions?.cues.length) return { path: null, markdown, cached: false };
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, markdown);
    await rename(tmp, path);
    return { path, markdown, cached: false };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

const score = (lang: string, manual: Set<string>): number =>
  (manual.has(lang) ? 10 : 0) + (lang === "en" ? 2 : lang === "en-orig" ? 1 : 0);
