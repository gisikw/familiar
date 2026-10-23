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

/* --- Decoder repetition guard ----------------------------------------------
 *
 * Parakeet occasionally loops on a pause and emits the same short phrase
 * hundreds of times ("a little bit of a little bit of ..." x500, Oct 23).
 * Collapse any 1..6-word sequence repeated MIN_REPEATS+ times back-to-back to a
 * single occurrence. Kev stutters and restates, so fewer than 5 repeats are
 * left alone. Comparison ignores case and punctuation; the kept copy is the
 * first, verbatim. Smallest n first, so a period-2 loop isn't mistaken for
 * three copies of a 6-gram.
 */
const MIN_REPEATS = 5;
const MAX_NGRAM = 6;

export function collapseRepeats(text: string, minRepeats = MIN_REPEATS, maxN = MAX_NGRAM): string {
  let tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < minRepeats) return text;
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  let changed = false;
  for (let n = 1; n <= maxN; n++) {
    const out: string[] = [];
    let i = 0;
    while (i < tokens.length) {
      if (i + n * minRepeats <= tokens.length) {
        const key = tokens.slice(i, i + n).map(norm);
        if (key.some((k) => k)) {
          let reps = 1;
          while (i + (reps + 1) * n <= tokens.length
            && tokens.slice(i + reps * n, i + (reps + 1) * n).every((t, j) => norm(t) === key[j])) reps++;
          if (reps >= minRepeats) {
            out.push(...tokens.slice(i, i + n));
            i += reps * n;
            changed = true;
            continue;
          }
        }
      }
      out.push(tokens[i]);
      i++;
    }
    tokens = out;
  }
  return changed ? tokens.join(" ") : text;
}
