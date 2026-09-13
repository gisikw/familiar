import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  Transport,
  writePinnedRoute,
  boundedExec,
  configuration,
  nativeInput,
  provisionRequest,
  workerProfileArtifact,
} from "./transport.mjs";
import {
  LIMITS,
  privateSpanActive,
  projection,
  artifactDigest,
  provisionedPaths,
} from "./contract.mjs";
const host_key =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "fa-transport-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = {
    url: "http://127.0.0.1:1234",
    token_file: join(root, "token"),
    ssh_config: join(root, "original"),
    jump: {
      alias: "proof-jump",
      hostname: "coordinator.invalid",
      user: "jump",
      port: 2222,
      host_key,
    },
    machines: [],
  };
  const m = {
    name: "test",
    session: "test",
    host_key,
    ssh_user: "worker",
    port: 24000,
    ssh_alias: "drover-test",
    profile: "/worker/profile",
    profile_mode: "enrolled",
    herdr_binary: "/worker/herdr",
    models: ["test/model"],
    jump: config.jump,
  };
  config.machines = [m];
  writeFileSync(
    config.ssh_config,
    "Host *\n Hostname malicious.invalid\n User other\n Port 666\n UserKnownHostsFile /incorrect/pins\n ProxyJump wrong-jump\n IdentityFile /explicit/operator/key\n",
  );
  return { root, config, m };
}
test("native overlay pins exact machine and jump keys, not ambient known_hosts", async (t) => {
  const { root, config, m } = fixture(t),
    route = writePinnedRoute(config, m, root);
  const get = async (alias) =>
    Object.fromEntries(
      (
        await boundedExec(
          "ssh",
          ["-F", route, "-G", alias],
          "",
          new AbortController().signal,
        )
      )
        .trim()
        .split("\n")
        .map((l) => {
          const n = l.indexOf(" ");
          return [l.slice(0, n), l.slice(n + 1)];
        }),
    );
  const target = await get(m.ssh_alias);
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.port, "24000");
  assert.equal(target.user, "worker");
  assert.equal(target.proxyjump, "proof-jump");
  assert.equal(target.globalknownhostsfile, "/dev/null");
  assert.equal(target.hostkeyalgorithms, "ssh-ed25519");
  assert.equal(target.stricthostkeychecking, "true");
  const jump = await get("proof-jump");
  assert.equal(jump.hostname, "coordinator.invalid");
  assert.equal(jump.user, "jump");
  assert.equal(jump.port, "2222");
  assert.equal(jump.hostkeyalias, "familiar-drover-jump");
  const pins = readFileSync(join(root, "test.known_hosts"), "utf8");
  assert.match(pins, /drover-test ssh-ed25519/);
  assert.match(pins, /familiar-drover-jump ssh-ed25519/);
});
test(
  "shutdown kills an abort-resistant local route child",
  { timeout: 5000 },
  async (t) => {
    const { root } = fixture(t);
    const marker = join(root, "ready");
    const controller = new AbortController();
    const run = boundedExec(
      process.execPath,
      [
        "-e",
        `
    require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `,
      ],
      "",
      controller.signal,
    );
    let pid;
    t.after(() => {
      controller.abort();
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    });
    for (let i = 0; i < 100 && !pid; i++) {
      try {
        pid = Number(readFileSync(marker, "utf8"));
      } catch {}
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(pid);
    controller.abort();
    await assert.rejects(run, /route unavailable/);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(alive, false);
    pid = undefined;
  },
);

test("catalog identity mismatch prevents Herdr RPC and never falls back to local", async (t) => {
  const { root, config, m } = fixture(t),
    transport = new Transport(config, root);
  let calls = 0;
  transport.http = async () => [{ ...m, online: true, host_key: "different" }];
  transport.rpc = async () => {
    calls++;
  };
  await assert.rejects(
    transport.identity(
      { machine_id: "test", machine_identity: m },
      new AbortController().signal,
    ),
    /identity/,
  );
  assert.equal(calls, 0);
  assert.throws(() => transport.enrolled("not-enrolled"), /no local fallback/);
  assert.throws(() => configuration(), /no local fallback/);
});
test("RPC carries route-generation precondition and rejects absent or wrong acknowledgment", async (t) => {
  const { root, config, m } = fixture(t);
  writeFileSync(config.token_file, randomBytes(32).toString("hex"));
  const transport = new Transport(config, root);
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const job = { machine_id: "test", machine_identity: m };
  const signal = new AbortController().signal;
  let tag;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers["If-Match"], '"24000"');
    return new Response(
      JSON.stringify({ result: { version: "0.9.0", protocol: 22 } }),
      { headers: tag ? { ETag: tag } : {} },
    );
  };
  await assert.rejects(
    transport.rpc(job, "ping", {}, signal),
    /route unavailable/,
  );
  tag = '"24001"';
  await assert.rejects(
    transport.rpc(job, "ping", {}, signal),
    /route unavailable/,
  );
  tag = '"24000"';
  assert.equal((await transport.rpc(job, "ping", {}, signal)).protocol, 22);
});

test("changing enrolled jump identity fences native actions before execution", async (t) => {
  const { root, config, m } = fixture(t),
    transport = new Transport(config, root);
  await assert.rejects(
    transport.native(
      {
        machine_id: "test",
        machine_identity: {
          ...m,
          jump: { ...m.jump, hostname: "old.invalid" },
        },
      },
      { operation: "read" },
      new AbortController().signal,
    ),
    /jump enrollment changed/,
  );
});
test("read-only plan carries only project/ref and harness facts; provisioning carries the pinned artifact", (t) => {
  const { root, config, m } = fixture(t);
  m.profile_mode = "familiar-tiamat-v1";
  delete m.profile;
  m.worker_env = { PATH: "/explicit/worker/toolchain/bin:/usr/bin:/bin" };
  const transport = new Transport(config, root);
  const machine_identity = transport.enrolled("test");
  assert.equal(
    machine_identity.profile_digest,
    artifactDigest(machine_identity.profile_artifact),
  );
  const folder =
    "/home/worker/.local/state/familiar/agents/jobs/agent-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const job = {
    machine_id: "test",
    machine_identity,
    job_id: "agent-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    settlement_nonce: "nonce",
    repo: "/home/worker/source/familiar",
    requested_ref: "HEAD",
    harness: "pi",
    settlement_path: `${folder}/settlement.json`,
    remote_profile: `${folder}/profile`,
    resolved_head: "a".repeat(40),
    profile_digest: machine_identity.profile_digest,
  };
  const plan = provisionRequest(job, "plan");
  assert.deepEqual(plan, {
    operation: "plan",
    job_id: job.job_id,
    nonce: "nonce",
    repo: job.repo,
    ref: "HEAD",
    harness: "pi",
    profile_mode: "familiar-tiamat-v1",
    herdr: "/worker/herdr",
    worker_path: m.worker_env.PATH,
  });
  // The five-file incident: a plan must never depend on the module graph.
  assert.ok(Buffer.byteLength(nativeInput(plan)) < 2048);
  const provision = provisionRequest(job, "provision");
  assert.equal(provision.profile_artifact, machine_identity.profile_artifact);
  assert.equal(provision.profile_digest, machine_identity.profile_digest);
  assert.equal(typeof provision.model_guard_source, "string");
  assert.ok(Buffer.byteLength(nativeInput(provision)) <= LIMITS.nativeRequest);
  assert.throws(
    () => nativeInput({ value: "x".repeat(LIMITS.nativeRequest + 1) }),
    /native request bound/,
  );
  // The plan result carries no digest; the admission pin is authoritative and
  // provisioning must echo it exactly.
  const planned = provisionedPaths(
    {
      remote_worktree: `${folder}/worktree`,
      settlement_path: `${folder}/settlement.json`,
      remote_profile: `${folder}/profile`,
      resolved_head: "a".repeat(40),
    },
    job,
  );
  assert.equal(planned.profile_digest, machine_identity.profile_digest);
  assert.throws(
    () => provisionedPaths({ ...planned, profile_digest: "0".repeat(64) }, job),
    /durable provision plan changed/,
  );
  // A job admitted under the retired bundle protocol cannot be provisioned by
  // this controller and says so.
  const legacy = {
    ...job,
    machine_identity: {
      ...machine_identity,
      profile_artifact: undefined,
      profile_bundle: {},
    },
  };
  assert.throws(() => provisionRequest(legacy, "plan"), {
    diagnostic: /retired five-file/,
  });
});
test("worker profile artifact is the exact import graph from the extensions tree, never a listed filename set", (t) => {
  const real = workerProfileArtifact();
  assert.equal(real.extension, "tiamat");
  assert.ok(Object.hasOwn(real.files, "tiamat/index.ts"));
  assert.ok(Object.keys(real.files).every((n) => n.endsWith(".ts")));
  // Every relative import of every shipped module is itself shipped, so the
  // worker can never fail to resolve a module the controller resolves.
  for (const [name, source] of Object.entries(real.files))
    for (const m of source.matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const dep = m[1].split("/");
      const dir = name.split("/").slice(0, -1);
      for (const s of dep.slice(0, -1))
        s === ".." ? dir.pop() : s === "." ? 0 : dir.push(s);
      assert.ok(
        Object.hasOwn(real.files, [...dir, dep.at(-1)].join("/")),
        `${name} -> ${m[1]}`,
      );
    }
  assert.ok(
    Object.values(real.files).reduce((n, s) => n + Buffer.byteLength(s), 0) <=
      LIMITS.artifact,
  );
  // Synthetic tree: a newly imported module rides along by construction ...
  const tree = mkdtempSync(join(tmpdir(), "fa-artifact-"));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  mkdirSync(join(tree, "ext/deep"), { recursive: true });
  mkdirSync(join(tree, "lib"));
  writeFileSync(
    join(tree, "ext/index.ts"),
    'import { a } from "./added.ts";\nimport "../lib/debug.ts";\nexport default () => a;\n',
  );
  writeFileSync(
    join(tree, "ext/added.ts"),
    'export * from "./deep/helper.ts";\nexport const a = 1;\n',
  );
  writeFileSync(join(tree, "ext/deep/helper.ts"), "export const h = 1;\n");
  writeFileSync(
    join(tree, "lib/debug.ts"),
    'import fs from "fs";\nexport const d = fs;\n',
  );
  writeFileSync(join(tree, "ext/unused.ts"), "export const never = 1;\n");
  const a = workerProfileArtifact("ext/index.ts", tree);
  assert.deepEqual(Object.keys(a.files).sort(), [
    "ext/added.ts",
    "ext/deep/helper.ts",
    "ext/index.ts",
    "lib/debug.ts",
  ]);
  assert.equal(a.extension, "ext");
  const before = artifactDigest(a);
  writeFileSync(join(tree, "ext/deep/helper.ts"), "export const h = 2;\n");
  assert.notEqual(
    artifactDigest(workerProfileArtifact("ext/index.ts", tree)),
    before,
  );
  // ... while anything outside the tree, non-source, or a symlink is refused
  // at the controller: credentials cannot be swept in by an import.
  for (const source of [
    'import "../../outside.ts";\n',
    'import "../lib/../../auth.json";\n',
    'import "./auth.json";\n',
    'import "./link.ts";\n',
  ]) {
    writeFileSync(join(tree, "ext/index.ts"), source);
    if (source.includes("link")) {
      writeFileSync(
        join(tree, "..", "outside-secret.ts"),
        "export const s = 1;\n",
      );
      symlinkSync(
        join(tree, "..", "outside-secret.ts"),
        join(tree, "ext/link.ts"),
      );
    }
    assert.throws(
      () => workerProfileArtifact("ext/index.ts", tree),
      /outside the extensions tree|regular file/,
    );
  }
  rmSync(join(tree, "..", "outside-secret.ts"), { force: true });
  // Bounds fail loudly at the controller, before any dispatch.
  writeFileSync(join(tree, "ext/index.ts"), 'import "./big.ts";\n');
  writeFileSync(join(tree, "ext/big.ts"), "//" + "x".repeat(LIMITS.artifact));
  assert.throws(
    () => workerProfileArtifact("ext/index.ts", tree),
    /artifact size bound/,
  );
  writeFileSync(
    join(tree, "ext/index.ts"),
    Array.from(
      { length: LIMITS.artifactFiles },
      (_, i) => `import "./m${i}.ts";`,
    ).join("\n"),
  );
  for (let i = 0; i < LIMITS.artifactFiles; i++)
    writeFileSync(join(tree, `ext/m${i}.ts`), "export {};\n");
  assert.throws(
    () => workerProfileArtifact("ext/index.ts", tree),
    /file count bound/,
  );
});
test("private span rejects Agents use until public/declassified context; pending head cannot be hidden", () => {
  assert.equal(
    privateSpanActive([
      {
        customType: "familiar-ui/transcript-visibility",
        data: { visibility: "private" },
      },
    ]),
    true,
  );
  assert.equal(
    privateSpanActive([
      {
        customType: "familiar-ui/transcript-visibility",
        data: { visibility: "private" },
      },
      { type: "message", message: { role: "user" } },
    ]),
    false,
  );
  const j = {
    intents: [
      { key: "first", kind: "steer", state: "delivery_unknown" },
      ...Array.from({ length: 127 }, (_, i) => ({
        key: String(i),
        kind: "steer",
        state: "delivered",
      })),
    ],
  };
  assert.equal(projection(j).pending_intent_count, 1);
  assert.equal(projection(j).pending_intents[0].key, "first");
});
