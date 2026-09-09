import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "./ledger.mjs";
import { Owner } from "./owner.mjs";

const request = {
  key: "recovery",
  machine_id: "test",
  harness: "pi",
  model: "test/model",
  repo: "/repo O'Brien",
  requested_ref: "HEAD",
  task: "test",
  label: "test",
};
const machine = { name: "test", session: "test", models: ["test/model"] };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "fa-recovery-"));
  const db = new Ledger(join(root, "ledger.sqlite"));
  const fence = db.acquire("test");
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, fence };
}

test("admission rejects control/config injection and bounds options before durable insert", (t) => {
  const { db, fence } = fixture(t);
  for (const override of [
    { repo: "relative" },
    { repo: "/repo\nother" },
    { requested_ref: "HEAD\n" },
    { options: { args: ["--extension", "/ambient"] } },
    { options: { thinking: "high\n--api-key" } },
    { options: [] },
  ])
    assert.throws(() =>
      db.admit(fence, { ...request, ...override }, machine, "exo"),
    );
  assert.equal(db.count(), 0);
  const j = db.admit(
    fence,
    { ...request, options: { thinking: "high" } },
    machine,
    "exo",
  );
  assert.equal(j.options.thinking, "high");
  assert.throws(() => db.admit(fence, request, machine, "exo"), /key reused/);
  assert.equal(
    db.admit(
      fence,
      { ...request, options: { thinking: "high" } },
      machine,
      "exo",
    ).job_id,
    j.job_id,
  );
});

test("explicit Exo terminal decisions are retryable but never replace first settlement or attribution", (t) => {
  const { db, fence } = fixture(t);
  const owner = new Owner(db, {}, async () => true);
  owner.fence = fence;
  const j = db.admit(fence, request, machine, "exo-session");
  const a = owner.operatorSettle(j.job_id, "done", "inspected", "exo:session");
  assert.equal(a.operator.actor, "exo:session");
  assert.deepEqual(
    owner.operatorSettle(j.job_id, "done", "inspected", "exo:session"),
    a,
  );
  assert.throws(
    () => owner.operatorSettle(j.job_id, "failed", "changed", "exo:session"),
    /terminal/,
  );
  assert.throws(
    () =>
      owner.operatorSettle(
        j.job_id,
        "done",
        "inspected",
        "operator-command:other",
      ),
    /terminal/,
  );
  const b = db.admit(
    fence,
    { ...request, key: "abandon" },
    machine,
    "exo-session",
  );
  const abandoned = owner.abandon(b.job_id, "operator asked", "exo:session");
  assert.deepEqual(
    owner.abandon(b.job_id, "operator asked", "exo:session"),
    abandoned,
  );
  assert.throws(
    () => owner.abandon(b.job_id, "different", "exo:session"),
    /terminal/,
  );
});

for (const boundary of [
  { phase: "provision" },
  {
    phase: "provision",
    settlement_path: "/pinned/settlement.json",
    resolved_head: "a".repeat(40),
  },
  { phase: "workspace_attempted" },
  {
    phase: "launch_attempted",
    herdr_workspace_id: "w1",
    herdr_pane_id: "w1:p1",
  },
  {
    phase: "observe",
    prompt_delivery: "unknown",
    task: "retained for explicit retry",
  },
  { phase: "observe", intents: [{ key: "steer", state: "delivery_unknown" }] },
])
  test(
    `SIGKILL at durable boundary ${JSON.stringify(boundary)}`,
    { timeout: 10000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), "fa-boundary-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const file = join(root, "ledger.sqlite");
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
    import { Ledger } from ${JSON.stringify(new URL("./ledger.mjs", import.meta.url).href)};
    const db = new Ledger(${JSON.stringify(file)}), f = db.acquire('child');
    const j = db.admit(f, ${JSON.stringify(request)}, ${JSON.stringify(machine)}, 'exo:session');
    db.update(f, j, ${JSON.stringify(boundary)});
    console.log(JSON.stringify({id:j.job_id, nonce:j.settlement_nonce}));
    setTimeout(()=>{}, 60000);
  `,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      t.after(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      const committed = await new Promise((resolve, reject) => {
        let text = "";
        child.stdout.on("data", (bytes) => {
          text += bytes;
          if (text.includes("\n")) resolve(JSON.parse(text.split("\n")[0]));
        });
        child.on("error", reject);
        child.on("exit", () => reject(new Error("child exited before commit")));
      });
      const exit = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exit;
      const db = new Ledger(file);
      t.after(() => db.close());
      const fence = db.acquire("replacement");
      assert.equal(fence.generation, 2);
      const recovered = db.admit(fence, request, machine, "new-session");
      assert.equal(recovered.job_id, committed.id);
      assert.equal(recovered.settlement_nonce, committed.nonce);
      assert.equal(recovered.owner_session, "exo:session");
      for (const [key, value] of Object.entries(boundary))
        assert.deepEqual(recovered[key], value);
      assert.throws(
        () => db.update({ owner: "child", generation: 1 }, recovered, {}),
        /lease lost/,
      );
    },
  );
