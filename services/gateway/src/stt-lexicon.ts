import fs from "node:fs";
import path from "node:path";

/* --- STT post-correction lexicon + opt-in take retention -------------------
 *
 * FAMILIAR_STT_LEXICON — path to a TSV of `heard<TAB>meant` lines. Each
 * `heard` is a whole-word, case-insensitive regex alternation (e.g.
 * `Kian|Kiyun|Akeen`); matches are replaced with `meant` verbatim. Blank lines
 * and `#` comments are ignored. Unset (the default) = transcripts untouched.
 * The file is re-read when its mtime changes, so edits need no restart.
 *
 * Only put near-certain fixes here: names Parakeet never gets right and that
 * have no plausible literal reading in Kev's speech. A wrong entry silently
 * rewrites his words; the 🗣 marker still tells the model to doubt them.
 *
 * FAMILIAR_STT_KEEP_DIR — when set, every successfully transcribed chunk is
 * written there as `<iso>-t<take>-s<seq>.audio` plus a `.txt` holding the raw
 * (pre-lexicon) transcript. This is the corpus for a real STT A/B and for
 * Parakeet personalization. Raw audio of Kev's voice: directory is created
 * 0700, files 0600; unset (the default) keeps nothing.
 */

type Rule = { re: RegExp; meant: string };
let cache: { file: string; mtimeMs: number; rules: Rule[] } | null = null;

export function parseLexicon(src: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of src.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const [heard, meant] = line.split("\t");
    if (!heard?.trim() || meant === undefined) continue;
    try {
      rules.push({ re: new RegExp(`(?<![\\p{L}\\p{N}'])(?:${heard.trim()})(?![\\p{L}\\p{N}'])`, "giu"), meant: meant.trim() });
    } catch { /* skip an unparseable pattern rather than drop the transcript */ }
  }
  return rules;
}

export function applyLexicon(text: string, rules: Rule[]): string {
  return rules.reduce((t, r) => t.replace(r.re, r.meant), text);
}

function loadRules(): Rule[] {
  const file = process.env.FAMILIAR_STT_LEXICON;
  if (!file) return [];
  try {
    const { mtimeMs } = fs.statSync(file);
    if (cache?.file !== file || cache.mtimeMs !== mtimeMs) {
      cache = { file, mtimeMs, rules: parseLexicon(fs.readFileSync(file, "utf8")) };
    }
    return cache.rules;
  } catch {
    return [];
  }
}

export function correctTranscript(text: string): string {
  const rules = loadRules();
  return rules.length ? applyLexicon(text, rules) : text;
}

export function keepTake(data: string, text: string, take: number, seq: number) {
  const dir = process.env.FAMILIAR_STT_KEEP_DIR;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stem = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-t${take}-s${seq}`);
    fs.writeFileSync(`${stem}.audio`, Buffer.from(data, "base64"), { mode: 0o600 });
    fs.writeFileSync(`${stem}.txt`, text + "\n", { mode: 0o600 });
  } catch {
    /* retention is best-effort; it must never cost a voice turn */
  }
}
