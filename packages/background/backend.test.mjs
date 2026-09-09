import test from "node:test";
import assert from "node:assert/strict";
import { ChildBackend } from "./backend.mjs";

test("backend owns storage: finite retention, reported high-water admission and no deletion fallback", async () => {
  let resources,
    creates = 0,
    fail = false;
  const backend = new ChildBackend(
    {
      capabilities: async () => {
        if (fail) throw new Error("offline");
        return resources ? { resources } : {};
      },
      dispatch: async (request) => {
        creates++;
        assert.equal(request.artifacts.retention_days, 14);
        return { id: request.idempotency_key };
      },
    },
    { softBytes: 100 },
  );
  assert.equal(backend.resourceStatus().hardQuota, false);
  await backend.dispatch({ idempotency_key: "stable" });
  resources = { usageBytes: 100, admission: "available" };
  await assert.rejects(backend.dispatch({}), /cannot admit/);
  assert.equal(creates, 1);
  assert.equal(backend.resourceStatus().admission, "blocked");
  resources = {
    usageBytes: 50,
    softLimitBytes: 60,
    hardQuota: true,
    admission: "available",
  };
  await backend.dispatch({ idempotency_key: "stable2" });
  assert.equal(backend.resourceStatus().softLimitBytes, 60);
  assert.equal(backend.resourceStatus().hardQuota, true);
  resources.highWater = true;
  await assert.rejects(backend.dispatch({}), /cannot admit/);
  fail = true;
  await assert.rejects(backend.dispatch({}), /offline/);
  assert.equal(creates, 2);
  assert.equal(backend.deleteWorktree, undefined);
  assert.equal(backend.removeArtifacts, undefined);
});

test("malformed accounting and backend admission failures fail closed, with no alternate backend/key", async () => {
  const requests = [];
  let resources = { usageBytes: -1 };
  const backend = new ChildBackend({
    capabilities: async () => ({ resources }),
    dispatch: async (request) => {
      requests.push(request);
      throw new Error("capacity");
    },
  });
  await assert.rejects(
    backend.dispatch({ idempotency_key: "same" }),
    /accounting/,
  );
  assert.equal(requests.length, 0);
  resources = { usageBytes: 0 };
  await assert.rejects(
    backend.dispatch({ idempotency_key: "same" }),
    /capacity/,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].idempotency_key, "same");
  assert.equal(backend.resourceStatus().admission, "blocked");
});
