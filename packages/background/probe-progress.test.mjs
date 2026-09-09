import test from "node:test";
import assert from "node:assert/strict";
import { ProbeProgress, discoverProbeModel } from "./probe-progress.mjs";
import { discoverCatalogRow } from "./probe-catalog.mjs";

const delta = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "1" } };
const end = (stopReason) => ({ type: "message_end", message: { role: "assistant", stopReason } });

test("HTTP 200 is not branch inference evidence", () => {
  const p = new ProbeProgress();
  p.observe(1, { type: "after_provider_response", status: 200 });
  p.observe(2, { type: "after_provider_response", status: 200 });
  assert.equal(p.branchesActive(), false);
  p.observe(1, delta);
  assert.equal(p.branchesActive(), false);
  p.observe(2, delta);
  assert.equal(p.branchesActive(), true);
  p.observe(2, end("stop"));
  assert.equal(p.branchesActive(), false);
});

for (const event of [end("error"), end("aborted"), { type: "message_update", assistantMessageEvent: { type: "error" } }]) {
  test(`stream failure rejects overlap: ${JSON.stringify(event)}`, () => {
    const p = new ProbeProgress();
    p.observe(1, delta);
    p.observe(2, delta);
    p.observe(2, event);
    assert.throws(() => p.branchesActive(), /stream failed/);
  });
}

test("runtime discovery stays on configured provider", async () => {
  const models = [{ provider: "other", id: "preferred" }, { provider: "authorized", id: "valid" }];
  const runtime = { getAvailable: async (provider, options) => {
    assert.equal(provider, "authorized");
    assert.ok(options.signal instanceof AbortSignal);
    return models;
  } };
  assert.equal((await discoverProbeModel(runtime, "authorized", "preferred")).id, "valid");
  await assert.rejects(discoverProbeModel({ getAvailable: async () => models }, "absent"), /no available model/);
});

const row = { provider: "authorized", model: "valid", api: "/responses/v1/responses", availability: "available", fidelity: "native" };
const catalog = (rows) => ({ baseUrl: "http://localhost/", token: "test-only", authorized: [row],
  fetchImpl: async (url, options) => {
    assert.equal(url, "http://localhost/tiamat/v1/models");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify(rows));
  } });

test("live catalog requires matching wire, provider and availability; strips metadata", async () => {
  assert.deepEqual(await discoverCatalogRow(catalog([{ ...row, headers: { irrelevant: true } }])), row);
  for (const changed of [{ provider: "foreign" }, { api: "/anthropic/v1/messages" }, { availability: "unavailable" }])
    await assert.rejects(discoverCatalogRow(catalog([{ ...row, ...changed }])), /not available/);
  await assert.rejects(discoverCatalogRow(catalog([row, row])), /not available/);
  await assert.rejects(discoverCatalogRow({ ...catalog([row]), modelId: "missing" }), /not available/);
});

test("catalog response has a hard byte bound and fails on HTTP errors", async () => {
  await assert.rejects(discoverCatalogRow(catalog(["x".repeat(1024 * 1024)])), /size limit/);
  await assert.rejects(discoverCatalogRow({ ...catalog([]), fetchImpl: async () => new Response("secret error", { status: 401 }) }), /catalog request failed/);
});
