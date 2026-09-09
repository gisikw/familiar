import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Transport,
  writePinnedRoute,
  boundedExec,
  configuration,
} from "./transport.mjs";
import { privateSpanActive, projection } from "./contract.mjs";
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
