import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  POLICY_LIMITS,
  PolicyStore,
  effectiveDecision,
  enrollmentOf,
  parsePolicy,
  policyFilePath,
  serializePolicy,
  validateMutation,
} from "./policy.mjs";
import { Owner } from "./owner.mjs";

const enrollment = {
  nodes: new Map([
    ["azula", ["acct-a/opus-5", "acct-a/sonnet-5"]],
    ["ratched", ["acct-a/opus-5"]],
  ]),
};
function store(t) {
  const dir = mkdtempSync(join(tmpdir(), "familiar-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new PolicyStore(policyFilePath(dir)) };
}
const apply = (s, mutation) =>
  s.mutate(s.current().revision, mutation, enrollment);

test("known absence is an empty fail-closed policy with a real revision", (t) => {
  const { store: s, dir } = store(t);
  const snapshot = s.snapshot(enrollment);
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.routes, []);
  assert.match(snapshot.revision, /^[a-f0-9]{32}$/);
  assert.equal(s.effective("acct-a/opus-5", "azula"), "deny");
  assert.equal(policyFilePath(dir), join(dir, "agent-policy.json"));
});

test("persisted file is private, deterministic and survives a restart", (t) => {
  const { store: s, dir } = store(t);
  apply(s, { action: "set-on", route: "acct-a/opus-5", on: true });
  apply(s, { action: "set-fallback", route: "acct-a/opus-5", fallback: "allow" });
  const path = policyFilePath(dir);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const bytes = readFileSync(path, "utf8");
  assert.equal(
    bytes,
    '{"version":1,"seq":2,"routes":[{"route":"acct-a/opus-5","on":true,"fallback":"allow","overrides":{}}]}\n',
  );
  const reopened = new PolicyStore(path);
  assert.equal(reopened.effective("acct-a/opus-5", "azula"), "allow");
  assert.equal(reopened.current().revision, s.current().revision);
  // Deterministic serialization: sorted routes and sorted override keys.
  const doc = {
    version: 1,
    seq: 3,
    routes: [
      { route: "b/x", on: true, fallback: "deny", overrides: { b: "deny", a: "allow" } },
      { route: "a/x", on: false, fallback: "deny", overrides: {} },
    ],
  };
  assert.equal(
    serializePolicy(doc),
    serializePolicy({ version: 1, seq: 3, routes: [...doc.routes].reverse() }),
  );
  assert.ok(serializePolicy(doc).indexOf('"a/x"') < serializePolicy(doc).indexOf('"b/x"'));
});

test("malformed, unknown-version and oversized state fail closed", (t) => {
  for (const body of [
    "{",
    '{"version":2,"seq":0,"routes":[]}',
    '{"version":1,"seq":0,"routes":[],"extra":true}',
    '{"version":1,"seq":-1,"routes":[]}',
    '{"version":1,"seq":0,"routes":[{"route":"a/b","on":true,"fallback":"maybe","overrides":{}}]}',
    '{"version":1,"seq":0,"routes":[{"route":"a/b","on":true,"fallback":"allow","overrides":{"n":"yes"}}]}',
    // Exact identity collision: the same route recorded twice is refused whole.
    '{"version":1,"seq":0,"routes":[{"route":"a/b","on":true,"fallback":"allow","overrides":{}},{"route":"a/b","on":false,"fallback":"deny","overrides":{}}]}',
  ]) {
    const { store: s, dir } = store(t);
    writeFileSync(policyFilePath(dir), body, { mode: 0o600 });
    assert.throws(() => s.current(), /refusing/, body);
    assert.throws(() => s.effective("a/b", "azula"), /refusing/, body);
    assert.throws(() => apply(s, { action: "set-on", route: "acct-a/opus-5", on: true }), /refusing/);
    // Refusal never erases the operator's file.
    assert.equal(readFileSync(policyFilePath(dir), "utf8"), body);
  }
});

test("revision conflicts are stale, not silent overwrites", (t) => {
  const { store: s } = store(t);
  const first = s.current().revision;
  apply(s, { action: "set-on", route: "acct-a/opus-5", on: true });
  assert.throws(
    () => s.mutate(first, { action: "set-on", route: "acct-a/opus-5", on: false }, enrollment),
    (error) => error.code === "stale",
  );
  assert.equal(s.entry("acct-a/opus-5").on, true);
});

test("effective policy: off, fallback, overrides, late node, non-destructive off", (t) => {
  const { store: s } = store(t);
  apply(s, { action: "set-on", route: "acct-a/opus-5", on: true });
  apply(s, { action: "set-fallback", route: "acct-a/opus-5", fallback: "allow" });
  apply(s, {
    action: "set-override",
    route: "acct-a/opus-5",
    node: "ratched",
    decision: "deny",
  });
  assert.equal(s.effective("acct-a/opus-5", "azula"), "allow");
  assert.equal(s.effective("acct-a/opus-5", "ratched"), "deny");
  // A newly enrolled node inherits the fallback with no state rewrite.
  const before = readFileSync(s.path, "utf8");
  assert.equal(s.effective("acct-a/opus-5", "iroh"), "allow");
  assert.equal(readFileSync(s.path, "utf8"), before);
  // Turning the route off denies everything without destroying settings.
  apply(s, { action: "set-on", route: "acct-a/opus-5", on: false });
  assert.equal(s.effective("acct-a/opus-5", "azula"), "deny");
  assert.deepEqual(s.entry("acct-a/opus-5").overrides, { ratched: "deny" });
  assert.equal(s.entry("acct-a/opus-5").fallback, "allow");
  apply(s, { action: "set-on", route: "acct-a/opus-5", on: true });
  assert.equal(s.effective("acct-a/opus-5", "azula"), "allow");
  assert.equal(s.effective("acct-a/opus-5", "ratched"), "deny");
  apply(s, { action: "clear-override", route: "acct-a/opus-5", node: "ratched" });
  assert.equal(s.effective("acct-a/opus-5", "ratched"), "allow");
  // Absence of any entry is deny; explicit deny beats an allow fallback.
  assert.equal(s.effective("acct-a/sonnet-5", "azula"), "deny");
  assert.equal(effectiveDecision(undefined, "azula"), "deny");
});

test("policy may only restrict enrollment, never grant it", (t) => {
  const { store: s } = store(t);
  for (const mutation of [
    { action: "set-on", route: "unknown/model", on: true },
    { action: "set-override", route: "acct-a/opus-5", node: "unenrolled", decision: "allow" },
  ])
    assert.throws(
      () => apply(s, mutation),
      (error) => error.code === "invalid_request",
    );
  assert.deepEqual(s.snapshot(enrollment).routes, []);
});

test("mutation shapes are exact and bounded", (t) => {
  const { store: s } = store(t);
  for (const mutation of [
    null,
    { action: "delete-route", route: "acct-a/opus-5" },
    { action: "set-on", route: "acct-a/opus-5" },
    { action: "set-on", route: "acct-a/opus-5", on: "true" },
    { action: "set-on", route: "acct-a/opus-5", on: true, extra: 1 },
    { action: "set-override", route: "acct-a/opus-5", node: "azula", decision: "maybe" },
    { action: "set-on", route: "x".repeat(POLICY_LIMITS.routeBytes + 1), on: true },
  ])
    assert.throws(
      () => validateMutation(mutation),
      (error) => error.code === "invalid_request",
      JSON.stringify(mutation),
    );
  assert.throws(
    () => s.mutate(undefined, { action: "set-on", route: "acct-a/opus-5", on: true }, enrollment),
    /expected revision required/,
  );
});

test("snapshot projection is browser-safe, sorted and bounded", (t) => {
  const { store: s } = store(t);
  apply(s, { action: "set-on", route: "acct-a/sonnet-5", on: true });
  apply(s, { action: "set-on", route: "acct-a/opus-5", on: true });
  const transport = {
    config: {
      machines: [
        {
          name: "azula",
          models: ["acct-a/opus-5", "acct-a/sonnet-5"],
          host_key: "ssh-ed25519 AAAA",
          ssh_user: "worker",
          profile: "/enrolled/profile",
          worker_env: { FAMILIAR_TIAMAT_TOKEN_FILE: "/secret" },
        },
      ],
    },
    token: "must-not-appear",
  };
  const snapshot = s.snapshot(enrollmentOf(transport));
  assert.deepEqual(Object.keys(snapshot), ["version", "revision", "nodes", "routes"]);
  assert.deepEqual(snapshot.nodes, [{ id: "azula", routes: ["acct-a/opus-5", "acct-a/sonnet-5"] }]);
  assert.deepEqual(snapshot.routes.map((r) => r.route), [
    "acct-a/opus-5",
    "acct-a/sonnet-5",
  ]);
  const serialized = JSON.stringify(snapshot);
  for (const secret of ["ssh-ed25519", "worker", "/enrolled/profile", "/secret", "must-not-appear"])
    assert.equal(serialized.includes(secret), false, secret);
  // Optional reachability appears only when truthfully known.
  const withState = s.snapshot({
    nodes: enrollment.nodes,
    reachability: new Map([["azula", "online"], ["ratched", "guessed"]]),
  });
  assert.equal(withState.nodes.find((n) => n.id === "azula").reachability, "online");
  assert.equal("reachability" in withState.nodes.find((n) => n.id === "ratched"), false);
});

test("route and override bounds are enforced", (t) => {
  const { store: s } = store(t);
  const doc = {
    version: 1,
    seq: 1,
    routes: Array.from({ length: POLICY_LIMITS.routes + 1 }, (_, i) => ({
      route: `acct/model-${i}`,
      on: false,
      fallback: "deny",
      overrides: {},
    })),
  };
  assert.throws(() => parsePolicy(serializePolicy(doc)), /refusing/);
  const overrides = {};
  for (let i = 0; i <= POLICY_LIMITS.overridesPerRoute; i++) overrides[`node-${i}`] = "allow";
  assert.throws(
    () =>
      parsePolicy(
        serializePolicy({
          version: 1,
          seq: 1,
          routes: [{ route: "a/b", on: true, fallback: "deny", overrides }],
        }),
      ),
    /refusing/,
  );
});

test("a single in-process owner/writer is enforced", (t) => {
  const { store: s, dir } = store(t);
  const uninstall = s.install();
  t.after(uninstall);
  assert.throws(() => new PolicyStore(policyFilePath(dir)).install(), /process owner/);
  uninstall();
  const second = new PolicyStore(policyFilePath(dir));
  second.install()();
});

test("dispatch enforcement denies before admission and cannot be claimed by arguments", (t) => {
  const { store: s } = store(t);
  const ledger = {
    admit() {
      throw new Error("admission must not be reached for a denied dispatch");
    },
  };
  const transport = {
    admissionReady() {},
    enrolled: () => ({ name: "azula", models: ["acct-a/opus-5"] }),
    config: { machines: [{ name: "azula", models: ["acct-a/opus-5"] }] },
  };
  const owner = new Owner(ledger, transport, async () => true, { policy: s });
  owner.guard = () => {};
  owner.kick = () => {};
  assert.throws(
    () => owner.dispatch({ machine_id: "azula", harness: "pi", model: "acct-a/opus-5" }, "test"),
    (error) => error.code === "policy_denied" && /denies model/.test(error.message),
  );
  // No argument can assert approval; only persisted policy decides.
  assert.throws(
    () =>
      owner.dispatch(
        { machine_id: "azula", harness: "pi", model: "acct-a/opus-5", policy: "allow" },
        "test",
      ),
    (error) => error.code === "policy_denied",
  );
  // An unenrolled model fails enrollment before policy is consulted.
  assert.throws(
    () => owner.dispatch({ machine_id: "azula", harness: "pi", model: "other/model" }, "test"),
    /not explicitly enrolled/,
  );
  // A resident without a policy store denies rather than permitting.
  const bare = new Owner(ledger, transport, async () => true, {});
  bare.guard = () => {};
  assert.throws(
    () => bare.dispatch({ machine_id: "azula", harness: "pi", model: "acct-a/opus-5" }, "test"),
    (error) => error.code === "policy_denied" && /fail closed/.test(error.message),
  );
  // Allowed routes reach admission unchanged.
  s.mutate(
    s.current().revision,
    { action: "set-on", route: "acct-a/opus-5", on: true },
    { nodes: new Map([["azula", ["acct-a/opus-5"]]]) },
  );
  s.mutate(
    s.current().revision,
    { action: "set-override", route: "acct-a/opus-5", node: "azula", decision: "allow" },
    { nodes: new Map([["azula", ["acct-a/opus-5"]]]) },
  );
  let admitted = null;
  ledger.admit = (_fence, request) => {
    admitted = request;
    return { job_id: "job", intents: [], machine_identity: {} };
  };
  owner.dispatch(
    { machine_id: "azula", harness: "pi", model: "acct-a/opus-5" },
    "test",
  );
  assert.equal(admitted.model, "acct-a/opus-5");
});
