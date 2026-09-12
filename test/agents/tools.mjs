// Real pinned Pi loader + one Imp socket + real SQLite Owner. No provider,
// SSH endpoint, resident process, or controller credentials are involved.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
const root = mkdtempSync(join(tmpdir(), "fa-imp-"));
const ownerSlot = Symbol.for("familiar.agents.owner.v1");
const agentSlot = Symbol.for("familiar.imp.agent.v1");
const { loadExtensions } = await import(
  pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/core/extensions/loader.js"))
);
const config = join(root, "config.json");
const host_key =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4";
writeFileSync(join(root, "token"), randomBytes(32).toString("hex"), { mode: 0o600 });
writeFileSync(config, JSON.stringify({
  url: "http://127.0.0.1:1", token_file: join(root, "token"), ssh_config: join(root, "ssh"),
  jump: { alias: "jump", hostname: "localhost", user: "worker", port: 2222, host_key },
  machines: [{ name: "test", session: "test", host_key, port: 24000, ssh_user: "worker", ssh_alias: "worker", profile: "/enrolled/profile", herdr_binary: "/enrolled/herdr", models: ["test/model"] }],
}), { mode: 0o600 });
process.env.FAMILIAR_AGENTS_CONFIG = config;
process.env.FAMILIAR_AGENTS_STATE_DIR = join(root, "state");
process.env.FAMILIAR_WORKLIST_DIR = join(root, "worklist");
let loaded;
let entries = [];
const ctx = { mode: "tui", sessionManager: { getSessionId: () => "test-exo", getBranch: () => entries }, ui: { notify() {} } };
function wire(operation, args = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(process.env.FAMILIAR_IMP_SOCKET);
    let raw = "";
    socket.setTimeout(6000, () => socket.destroy(new Error("timeout")));
    socket.on("connect", () => socket.write(JSON.stringify({ version: 1, area: "agent", operation, args }) + "\n"));
    socket.on("data", (chunk) => raw += chunk);
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        const envelope = JSON.parse(raw.trim());
        if (!envelope.ok) reject(new Error(`${envelope.error.code}: ${envelope.error.message}`));
        else resolve(envelope.result);
      } catch (error) { reject(error); }
    });
  });
}
try {
  loaded = await loadExtensions([
    new URL("../../integrations/pi/extensions/agents/index.ts", import.meta.url).pathname,
    new URL("../../integrations/pi/extensions/imp/index.ts", import.meta.url).pathname,
  ], root, { emit() { throw new Error("optional projection failed"); }, on() { return () => {}; } });
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.flatMap((ext) => [...ext.tools.keys()]).filter((name) => name.startsWith("familiar_agents_")).length, 0);
  const event = async (name, context = ctx) => {
    for (const ext of loaded.extensions)
      for (const fn of ext.handlers.get(name) ?? []) await fn({}, context);
  };
  await event("session_start"); // Imp lives; no owner flag means Agent area unavailable.
  assert.ok(process.env.FAMILIAR_IMP_SOCKET);
  assert.equal(process[ownerSlot], undefined);
  await assert.rejects(wire("capabilities"), /unavailable/);
  loaded.runtime.flagValues.set("familiar-agents-owner", true);
  await event("session_start", { ...ctx, mode: "rpc" });
  assert.equal(process[ownerSlot], undefined);
  await event("session_start");
  const owner = process[ownerSlot];
  assert.ok(owner && process[agentSlot], "foreground owner publishes fixed Agent handler");
  owner.transport.identity = async () => false;
  assert.equal((await wire("capabilities")).machines[0].machine_id, "test");
  assert.deepEqual((await wire("capabilities", { machine: "test" })).models, ["test/model"]);
  const req = { key: "dispatch", machine: "test", harness: "pi", model: "test/model", thinking: "high", repo: "/repo", requested_ref: "HEAD", task: "test", label: "test" };
  // Policy starts empty and fail-closed: dispatch is denied before any ledger
  // admission or network contact.
  const policySlot = Symbol.for("familiar.agent-policy.v1");
  const service = process[policySlot];
  assert.ok(service && typeof service.read === "function", "foreground owner publishes the policy service");
  assert.deepEqual((await wire("policy-show")).routes, []);
  assert.deepEqual((await wire("policy-show")).nodes, [{ id: "test", routes: ["test/model"] }]);
  await assert.rejects(wire("dispatch", req), /policy_denied/);
  assert.equal(owner.ledger.count(), 0, "a denied dispatch admits no job");
  await assert.rejects(wire("policy-set", { action: "set-override", route: "other/model", node: "test", decision: "allow" }), /invalid_request/);
  await assert.rejects(wire("policy-set", { action: "set-override", route: "test/model", node: "absent", decision: "allow" }), /invalid_request/);
  assert.throws(() => service.mutate("not-the-revision", { action: "set-on", route: "test/model", on: true }), /stale/);
  await wire("policy-set", { action: "set-on", route: "test/model", on: true });
  await assert.rejects(wire("dispatch", req), /policy_denied/); // fallback still deny
  const enabled = await wire("policy-set", { action: "set-override", route: "test/model", node: "test", decision: "allow" });
  assert.equal(enabled.routes[0].overrides.test, "allow");
  assert.equal(service.read().revision, enabled.revision);
  const job = await wire("dispatch", req);
  assert.equal((await wire("dispatch", req)).job_id, job.job_id);
  assert.equal(job.options.thinking, "high");
  assert.match((await wire("status", { id: job.job_id })).attach_hint, /drover --config/);
  assert.equal((await wire("status", { offset: 0 })).total, 1);
  await wire("steer", { id: job.job_id, key: "steer", text: "review" });
  await wire("cancel", { id: job.job_id, key: "cancel" });
  await wire("reconcile");
  assert.equal((await wire("status", { id: job.job_id })).semantic_state, "cancel_requested");
  await wire("abandon", { id: job.job_id, reason: "operator request" });
  assert.equal((await wire("abandon", { id: job.job_id, reason: "operator request" })).operator.actor, "exo:test-exo");
  const second = await wire("dispatch", { ...req, key: "second" });
  owner.kick = () => {}; // Keep the synthetic blocked episode stable for action tests.
  let row = owner.ledger.get(second.job_id);
  row = owner.ledger.update(owner.fence, row, { phase: "observe", prompt_delivery: "unknown", semantic_state: "blocked", observation: "blocked", reachability: "fresh", blocked_seq: 1, blocked_episode: 1 });
  row = owner.ledger.update(owner.fence, row, { blocked_context: "🎈".repeat(16000) });
  assert.equal((await wire("status", { id: second.job_id })).truncated, true);
  row = owner.ledger.update(owner.fence, row, { blocked_context: null });
  await wire("resolve-operation", { id: second.job_id, operation: "prompt", resolution: "prompt-confirmed-delivered", reason: "inspected" });
  await wire("answer", { id: second.job_id, key: "answer", text: "yes" });
  row = owner.ledger.get(second.job_id);
  owner.ledger.update(owner.fence, row, { intents: row.intents.map((intent) => ({ ...intent, state: "delivery_unknown" })) });
  await wire("resolve-intent", { id: second.job_id, key: "answer", reason: "human answered natively" });
  await wire("settle", { id: second.job_id, verdict: "done", summary: "inspected worktree" });
  assert.equal((await wire("settle", { id: second.job_id, verdict: "done", summary: "inspected worktree" })).operator.actor, "exo:test-exo");
  await assert.rejects(wire("settle", { id: second.job_id, verdict: "failed", summary: "replace" }), /terminal/);
  await assert.rejects(wire("status", { offset: -1 }), /invalid_request/);
  await assert.rejects(wire("status", { unexpected: true }), /invalid_request/);
  entries = [{ customType: "familiar-ui/transcript-visibility", data: { visibility: "private" } }];
  await assert.rejects(wire("dispatch", { ...req, key: "private" }), /private/);
  await assert.rejects(wire("policy-show"), /private/);
  await assert.rejects(wire("policy-set", { action: "set-on", route: "test/model", on: false }), /private/);
  entries = [];
  await event("session_shutdown");
  assert.equal(process[ownerSlot], undefined);
  assert.equal(process[agentSlot], undefined);
  assert.equal(process[policySlot], undefined);
  assert.equal(process.env.FAMILIAR_IMP_SOCKET, undefined);
  console.log("Agents Imp ingress: fixed area, all operations, policy enforcement/seam, provenance, private rejection, validation, idempotency and lifecycle passed");
} finally {
  await process[ownerSlot]?.stop();
  delete process[agentSlot];
  rmSync(root, { recursive: true, force: true });
}
