const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldInjectBearer } = require("./bearer.js");

test("injects on our origin when the page sent no Authorization", () => {
  assert.equal(shouldInjectBearer({ Accept: "*/*" }, true, "tok"), true);
});

test("never overwrites the page's own Authorization (familiar-ui bridge bearer)", () => {
  assert.equal(shouldInjectBearer({ Authorization: "Bearer bridge" }, true, "tok"), false);
  assert.equal(shouldInjectBearer({ authorization: "Bearer bridge" }, true, "tok"), false);
});

test("never off-origin, never without a token", () => {
  assert.equal(shouldInjectBearer({}, false, "tok"), false);
  assert.equal(shouldInjectBearer({}, true, null), false);
});
