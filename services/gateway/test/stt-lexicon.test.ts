/* Run with:  nix develop .#stt -c bun test services/gateway/test/stt-lexicon.test.ts */
import { expect, test, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyLexicon, parseLexicon, correctTranscript, keepTake, lexiconNote } from "../src/stt-lexicon.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stt-lexicon-"));
afterEach(() => { delete process.env.FAMILIAR_STT_LEXICON; delete process.env.FAMILIAR_STT_KEEP_DIR; });

const rules = parseLexicon("# names\nKian|Kiyun|Akeen\tCian\nKess\tKes\n\nbad(\tx\nnotab\n");

test("whole-word, case-insensitive, keeps punctuation", () => {
  expect(applyLexicon("Kian gets confused, Kiyun. Hello there Kess!", rules)).toBe("Cian gets confused, Cian. Hello there Kes!");
});

test("does not touch substrings or possessive-adjacent words", () => {
  expect(applyLexicon("Kianna and Kessler, Kian's book", rules)).toBe("Kianna and Kessler, Kian's book");
});

test("unparseable patterns and malformed lines are skipped, not fatal", () => {
  expect(rules.length).toBe(2);
});

test("unset lexicon env leaves transcripts untouched", () => {
  expect(correctTranscript("Kian").text).toBe("Kian");
});

test("lexicon file is applied and re-read on change", async () => {
  const f = path.join(tmp, "lex.tsv");
  fs.writeFileSync(f, "Kian\tCian\n");
  process.env.FAMILIAR_STT_LEXICON = f;
  expect(correctTranscript("Kian").text).toBe("Cian");
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(f, "Kian\tKeean\n");
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  expect(correctTranscript("Kian").text).toBe("Keean");
  process.env.FAMILIAR_STT_LEXICON = path.join(tmp, "missing.tsv");
  expect(correctTranscript("Kian").text).toBe("Kian");
});

test("keepTake writes private audio + raw transcript only when enabled", () => {
  keepTake(Buffer.from("x").toString("base64"), "hi", 1, 0);
  const dir = path.join(tmp, "keep");
  process.env.FAMILIAR_STT_KEEP_DIR = dir;
  keepTake(Buffer.from("RIFF").toString("base64"), "Kian said hi", 7, 2);
  const files = fs.readdirSync(dir).sort();
  expect(files.length).toBe(2);
  expect(files[0]).toMatch(/-t7-s2\.audio$/);
  expect(fs.readFileSync(path.join(dir, files[1]), "utf8")).toBe("Kian said hi\n");
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(dir, files[0])).mode & 0o777).toBe(0o600);
});

test("Kinect→Connect: whole-word, case-preserving, and every rewrite is reported", () => {
  const kinect = parseLexicon("Kinect\tConnect\n");
  const fixes: { heard: string; meant: string }[] = [];
  expect(applyLexicon("Kinect, kinect and KINECT; not Kinects or kinected", kinect, fixes))
    .toBe("Connect, connect and CONNECT; not Kinects or kinected");
  expect(fixes.map((f) => f.heard)).toEqual(["Kinect", "kinect", "KINECT"]);
  expect(lexiconNote(fixes)).toBe(" (stt-lexicon: Kinect→Connect, kinect→connect, KINECT→CONNECT)");
  expect(lexiconNote([])).toBe("");
});

test("correctTranscript reports fixes so the take can be annotated", () => {
  const f = path.join(tmp, "kinect.tsv");
  fs.writeFileSync(f, "Kinect\tConnect\n");
  process.env.FAMILIAR_STT_LEXICON = f;
  expect(correctTranscript("the Kinect sync")).toEqual({ text: "the Connect sync", fixes: [{ heard: "Kinect", meant: "Connect" }] });
  expect(correctTranscript("nothing here")).toEqual({ text: "nothing here", fixes: [] });
});
