const test = require("node:test");
const assert = require("node:assert/strict");
const { windowOpenTarget, navigationTarget } = require("./links.js");

const base = "https://familiar-ui.gisi.network";
const here = `${base}/?session=abc`;

test("new windows always leave the app for http(s)/mailto", () => {
  assert.equal(windowOpenTarget("https://example.com/x"), "external");
  assert.equal(windowOpenTarget(`${base}/?doc=/a.md&popout=1`), "external"); // reader pop-out
  assert.equal(windowOpenTarget("mailto:kevin@example.com"), "external");
  assert.equal(windowOpenTarget("javascript:alert(1)"), "deny");
  assert.equal(windowOpenTarget("file:///etc/passwd"), "deny");
  assert.equal(windowOpenTarget("not a url"), "deny");
});

test("links followed from Familiar leave for the default browser", () => {
  assert.equal(navigationTarget(`${base}/?session=def`, base, here), "allow");
  assert.equal(navigationTarget("https://wireframes.gisi.network/reader-v2/", base, here), "external");
  assert.equal(navigationTarget("https://github.com/gisikw/familiar", base, here), "external");
  assert.equal(navigationTarget("http://familiar-ui.gisi.network/", base, here), "external"); // other origin
  assert.equal(navigationTarget("mailto:x@y.z", base, here), "external");
  assert.equal(navigationTarget("javascript:alert(1)", base, here), "deny");
});

test("off-Familiar pages (offline page, SSO mid-login) navigate normally", () => {
  assert.equal(navigationTarget("file:///app/offline.html", base, here), "allow");
  assert.equal(navigationTarget(base, base, "file:///app/offline.html"), "allow");
  assert.equal(navigationTarget("https://identity.gisi.network/consent", base, "https://identity.gisi.network/login"), "allow");
  assert.equal(navigationTarget(`${base}/`, base, "https://identity.gisi.network/login"), "allow");
});
