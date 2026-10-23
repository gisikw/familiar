/* Run with:  nix develop .#stt -c bun test services/gateway/test/stt-repeat.test.ts */
import { expect, test } from "bun:test";
import { collapseRepeats } from "../src/stt-lexicon.ts";

test("Oct 23 Parakeet loop: 'a little bit of' x500 collapses to one", () => {
  const loop = Array(500).fill("a little bit of").join(" ");
  const input = `Should we have ${loop} more. Like the one thing that gives me pause`;
  expect(collapseRepeats(input)).toBe("Should we have a little bit of more. Like the one thing that gives me pause");
});

test("normal stutters and restatements under 5 are untouched", () => {
  const s = "I I I think the the um, yeah, yeah, yeah, no. It's it's fine, you know, you know.";
  expect(collapseRepeats(s)).toBe(s);
  expect(collapseRepeats("go go go go")).toBe("go go go go");
});

test("exactly 5 repeats collapses; case and punctuation ignored", () => {
  expect(collapseRepeats("ok so Yeah, yeah. yeah yeah YEAH then")).toBe("ok so Yeah, then");
});

test("period-2 loop isn't kept as 6-gram copies", () => {
  expect(collapseRepeats(Array(30).fill("uh huh").join(" ") + " done")).toBe("uh huh done");
});

test("text without loops is returned byte-identical", () => {
  const s = "  spaced   out\ttext stays as-is  ";
  expect(collapseRepeats(s)).toBe(s);
});
