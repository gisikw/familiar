const test = require("node:test");
const assert = require("node:assert/strict");
const { isOwnOrigin, pickRequestOrigin, originOf } = require("./origins.js");

const BASE = "https://familiar.gisi.network";

test("own origin matches full URLs, bare origins and trailing slashes", () => {
  assert.equal(isOwnOrigin("https://familiar.gisi.network/", BASE), true);
  assert.equal(isOwnOrigin("https://familiar.gisi.network", BASE), true);
  assert.equal(isOwnOrigin("https://familiar.gisi.network/reader?x=1#y", BASE), true);
});

test("a moved origin still counts as ours", () => {
  assert.equal(isOwnOrigin("https://familiar-ui.gisi.network/", BASE), true);
});

test("foreign, empty and opaque origins are refused", () => {
  assert.equal(isOwnOrigin("https://evil.example/", BASE), false);
  assert.equal(isOwnOrigin("http://familiar.gisi.network/", BASE), false);
  assert.equal(isOwnOrigin("", BASE), false);
  assert.equal(isOwnOrigin("null", BASE), false);
  assert.equal(isOwnOrigin("file:///Applications/Familiar.app/offline.html", BASE), false);
  assert.equal(isOwnOrigin("https://familiar.gisi.network/", null), false);
});

test("pickRequestOrigin skips empty/opaque candidates and falls back to the loaded URL", () => {
  assert.equal(pickRequestOrigin("", undefined, "https://familiar.gisi.network/chat"), BASE);
  assert.equal(pickRequestOrigin("null", "https://familiar.gisi.network/"), BASE);
  assert.equal(pickRequestOrigin("https://a.example/x", "https://familiar.gisi.network/"), "https://a.example");
  assert.equal(pickRequestOrigin("", null, ""), null);
  assert.equal(originOf("about:blank"), null);
});
