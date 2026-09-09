// Real pinned Pi loader + registered tools + real SQLite owner. No provider,
// SSH endpoint, resident process, or controller credentials are involved.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
const root = mkdtempSync(join(tmpdir(), "fa-tools-"));
const slot = Symbol.for("familiar.agents.owner.v1");
const { loadExtensions } = await import(
  pathToFileURL(
    join(process.env.PI_PACKAGE_DIR, "dist/core/extensions/loader.js"),
  )
);
const config = join(root, "config.json");
const host_key =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4";
writeFileSync(join(root, "token"), randomBytes(32).toString("hex"), {
  mode: 0o600,
});
writeFileSync(
  config,
  JSON.stringify({
    url: "http://127.0.0.1:1",
    token_file: join(root, "token"),
    ssh_config: join(root, "ssh"),
    jump: {
      alias: "jump",
      hostname: "localhost",
      user: "worker",
      port: 2222,
      host_key,
    },
    machines: [
      {
        name: "test",
        session: "test",
        host_key,
        port: 24000,
        ssh_user: "worker",
        ssh_alias: "worker",
        profile: "/enrolled/profile",
        herdr_binary: "/enrolled/herdr",
        models: ["test/model"],
      },
    ],
  }),
  { mode: 0o600 },
);
process.env.FAMILIAR_AGENTS_CONFIG = config;
process.env.FAMILIAR_AGENTS_STATE_DIR = join(root, "state");
process.env.FAMILIAR_WORKLIST_DIR = join(root, "worklist");
let loaded;
let entries = [];
const ctx = {
  mode: "tui",
  sessionManager: { getSessionId: () => "test-exo", getBranch: () => entries },
  ui: { notify() {} },
};
try {
  loaded = await loadExtensions(
    [
      new URL(
        "../../integrations/pi/extensions/agents/index.ts",
        import.meta.url,
      ).pathname,
    ],
    root,
    {
      emit() {
        throw new Error("optional projection failed");
      },
      on() {
        return () => {};
      },
    },
  );
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0];
  const event = async (name, context = ctx) => {
    for (const fn of ext.handlers.get(name) ?? []) await fn({}, context);
  };
  const call = async (name, params = {}) => {
    const tool = ext.tools.get(`familiar_agents_${name}`)?.definition;
    assert.ok(tool, `registered tool ${name}`);
    const result = await tool.execute(
      "test-call",
      params,
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
    assert.ok(Buffer.byteLength(result.content[0].text) < 48000);
    assert.ok(Buffer.byteLength(JSON.stringify(result.details)) < 48000);
    return result.details;
  };
  await event("session_start"); // no flag: background/SDK must never own
  assert.equal(process[slot], undefined);
  await assert.rejects(call("capabilities"), /no local fallback/);
  loaded.runtime.flagValues.set("familiar-agents-owner", true);
  await event("session_start", { ...ctx, mode: "rpc" });
  assert.equal(process[slot], undefined);
  await event("session_start");
  const owner = process[slot];
  assert.ok(owner, "throwing UI subscriber must not orphan owner");
  owner.transport.identity = async () => false;
  const machines = await call("capabilities");
  assert.equal(machines.machines[0].machine_id, "test");
  assert.deepEqual(
    (await call("capabilities", { machine_id: "test" })).models,
    ["test/model"],
  );
  const req = {
    key: "dispatch",
    machine_id: "test",
    harness: "pi",
    model: "test/model",
    repo: "/repo",
    requested_ref: "HEAD",
    task: "test",
    label: "test",
    options: { thinking: "high" },
  };
  const j = await call("dispatch", req);
  assert.equal((await call("dispatch", req)).job_id, j.job_id);
  assert.equal(j.options.thinking, "high");
  assert.match(
    (await call("status", { id: j.job_id })).attach_hint,
    /drover --config/,
  );
  assert.equal((await call("status")).total, 1);
  await call("steer", { id: j.job_id, key: "steer", text: "review" });
  await call("cancel", { id: j.job_id, key: "cancel" });
  await call("reconcile");
  assert.equal(
    (await call("status", { id: j.job_id })).semantic_state,
    "cancel_requested",
  );
  await call("abandon", { id: j.job_id, reason: "operator request" });
  const abandoned = await call("abandon", {
    id: j.job_id,
    reason: "operator request",
  });
  assert.equal(abandoned.operator.actor, "exo:test-exo");
  const second = await call("dispatch", { ...req, key: "second" });
  const id = second.job_id;
  let row = owner.ledger.get(id);
  row = owner.ledger.update(owner.fence, row, {
    phase: "observe",
    prompt_delivery: "unknown",
    semantic_state: "blocked",
    observation: "blocked",
    reachability: "fresh",
    blocked_seq: 1,
    blocked_episode: 1,
  });
  row = owner.ledger.update(owner.fence, row, {
    blocked_context: "🎈".repeat(16000),
  });
  assert.equal((await call("status", { id })).truncated, true);
  owner.ledger.update(owner.fence, row, { blocked_context: null });
  await call("resolve_operation", {
    id,
    operation: "prompt",
    resolution: "prompt-confirmed-delivered",
    reason: "inspected",
  });
  await call("answer", { id, key: "answer", text: "yes" });
  row = owner.ledger.get(id);
  owner.ledger.update(owner.fence, row, {
    intents: row.intents.map((i) => ({ ...i, state: "delivery_unknown" })),
  });
  await call("resolve_intent", {
    id,
    key: "answer",
    reason: "human answered natively",
  });
  await call("settle", { id, verdict: "done", summary: "inspected worktree" });
  const settled = await call("settle", {
    id,
    verdict: "done",
    summary: "inspected worktree",
  });
  assert.equal(settled.operator.actor, "exo:test-exo");
  await assert.rejects(
    call("settle", { id, verdict: "failed", summary: "replacement" }),
    /terminal/,
  );
  entries = [
    {
      customType: "familiar-ui/transcript-visibility",
      data: { visibility: "private" },
    },
  ];
  await assert.rejects(call("dispatch", { ...req, key: "private" }), /private/);
  entries = [];
  await event("session_shutdown");
  assert.equal(process[slot], undefined);
  await event("session_start");
  process[slot].transport.identity = async () => false;
  assert.equal((await call("status", { id })).semantic_state, "settled");
  assert.equal((await call("dispatch", req)).job_id, j.job_id);
  await event("session_shutdown");
  console.log(
    `Agents tools: ${ext.tools.size} registered; foreground gating, all actions, provenance, private rejection, restart/idempotency passed`,
  );
} finally {
  await process[slot]?.stop();
  rmSync(root, { recursive: true, force: true });
}
