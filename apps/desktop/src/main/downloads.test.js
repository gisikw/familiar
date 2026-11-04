const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { safeName, uniqueDownloadPath } = require("./downloads.js");

test("download names stay a single safe leaf", () => {
  assert.equal(safeName("sample.excalidraw"), "sample.excalidraw");
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("a\\b\\c.txt"), "c.txt");
  assert.equal(safeName(""), "download");
  assert.equal(safeName(".."), "download");
  assert.equal(safeName("bad\u0007name.md"), "badname.md");
});

test("downloads never overwrite: name (1), name (2) …", () => {
  const dir = "/Users/k/Downloads";
  const taken = new Set([path.join(dir, "a.zip"), path.join(dir, "a (1).zip")]);
  const exists = (p) => taken.has(p);
  assert.equal(uniqueDownloadPath(dir, "a.zip", exists), path.join(dir, "a (2).zip"));
  assert.equal(uniqueDownloadPath(dir, "b.zip", exists), path.join(dir, "b.zip"));
  const noExt = new Set([path.join(dir, "README")]);
  assert.equal(uniqueDownloadPath(dir, "README", (p) => noExt.has(p)), path.join(dir, "README (1)"));
  const dot = new Set([path.join(dir, ".env")]);
  assert.equal(uniqueDownloadPath(dir, ".env", (p) => dot.has(p)), path.join(dir, ".env (1)"));
});
