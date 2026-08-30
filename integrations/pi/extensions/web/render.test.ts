import test from "node:test";
import assert from "node:assert/strict";
import { searchResultsMarkdown } from "./render.ts";

test("renders HTTP search results as Markdown links", () => {
  assert.equal(
    searchResultsMarkdown([{ title: "Pi [docs]", url: "https://example.com/a_(b)", snippet: "useful\nresult" }], false),
    "- [Pi \\[docs\\]](https://example.com/a_%28b%29)",
  );
});

test("shows snippets only when expanded and does not link unsafe schemes", () => {
  const results = [
    { title: "Example", url: "https://example.com", snippet: "one\ntwo" },
    { title: "Local", url: "file:///etc/passwd", snippet: "hidden" },
  ];
  assert.equal(
    searchResultsMarkdown(results, true),
    "- [Example](https://example.com/)\n  one two\n- Local\n  hidden",
  );
});
