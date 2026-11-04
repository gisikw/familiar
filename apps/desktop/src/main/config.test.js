const test = require("node:test");
const assert = require("node:assert/strict");
const { migrateBaseUrl, resolveBaseUrl, DEFAULT_BASE_URL } = require("./config.js");

test("a saved familiar-ui.gisi.network moves to familiar.gisi.network", () => {
  assert.equal(migrateBaseUrl("https://familiar-ui.gisi.network"), "https://familiar.gisi.network");
  assert.equal(migrateBaseUrl("https://familiar-ui.gisi.network/sub"), "https://familiar.gisi.network/sub");
  assert.equal(migrateBaseUrl("https://familiar.gisi.network"), "https://familiar.gisi.network");
  assert.equal(migrateBaseUrl("http://localhost:1692"), "http://localhost:1692");
  assert.equal(migrateBaseUrl("http://familiar-ui.gisi.network"), "http://familiar-ui.gisi.network"); // not the moved origin
});

test("resolveBaseUrl applies the move to config.json values", () => {
  const saved = process.env.FAMILIAR_BASE_URL;
  delete process.env.FAMILIAR_BASE_URL;
  try {
    assert.equal(resolveBaseUrl(null, { baseUrl: "https://familiar-ui.gisi.network/" }), "https://familiar.gisi.network");
    assert.equal(resolveBaseUrl(null, {}), DEFAULT_BASE_URL);
  } finally {
    if (saved !== undefined) process.env.FAMILIAR_BASE_URL = saved;
  }
});
