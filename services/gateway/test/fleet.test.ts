import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FleetError, FleetRegistry, fleetConfigFromEnv, handleFleet, normalizeEd25519Key } from "../src/fleet.ts";

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}
function key(fill: number): string {
  const blob = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(Buffer.alloc(32, fill))]);
  return `ssh-ed25519 ${blob.toString("base64")} test-comment`;
}
async function fixture(min = 24000, max = 24002) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "familiar-fleet-"));
  const config = {
    stateDir: root, portMin: min, portMax: max, tunnelHost: "fleet.example.test",
    tunnelSSHPort: 2222, tunnelUser: "fleet_tunnel", controllerPublicKey: normalizeEd25519Key(key(9)),
    controllerIdentityFile: "/run/keys/fleet-controller", forcedCommand: "/bin/false",
  };
  const registry = new FleetRegistry(config, () => "2026-09-21T12:00:00.000Z");
  await registry.initialize();
  return { root, config, registry };
}
function enrollment(host: string, n: number) {
  return { host, tunnel_public_key: key(n), ssh_host_public_key: key(n + 100), ssh_user: "local-user" };
}

test("fleet configuration is opt-in and remains inside the gateway auth boundary", () => {
  assert.equal(fleetConfigFromEnv({}), undefined);
  assert.throws(() => fleetConfigFromEnv({ FAMILIAR_FLEET_STATE_DIR: "/tmp/fleet" }), /TUNNEL_HOST is required/);
  // There is intentionally no fleet bearer-token setting: the endpoint uses
  // the gateway's loopback/authenticating-proxy boundary rather than weakening
  // it with a parallel credential mechanism.
});

test("enrollment is idempotent and concurrent allocation cannot collide", async (t) => {
  const { root, registry } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const one = await registry.enroll(enrollment("Node-One", 1));
  const same = await registry.enroll(enrollment("node-one", 1));
  assert.deepEqual(same, one);
  // A second registry instance models an accidentally overlapping service
  // process and exercises the on-disk allocation lock, not only the queue.
  const otherProcess = new FleetRegistry(registry.config);
  const [two, three] = await Promise.all([registry.enroll(enrollment("node-two", 2)), otherProcess.enroll(enrollment("node-three", 3))]);
  assert.deepEqual(new Set([one.port, two.port, three.port]), new Set([24000, 24001, 24002]));
  await assert.rejects(() => registry.enroll(enrollment("node-four", 4)), (error: FleetError) => error.status === 503);
});

test("HTTP contract inherits the boundary without accepting a parallel credential", async (t) => {
  const { root, registry } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleFleet(registry, req, res, pathname).catch((error) => {
      const status = error instanceof FleetError ? error.status : 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/fleet`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(enrollment("api-node", 5)),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.host, "api-node"); assert.equal(body.remote_session, "familiar-fleet");
  assert.equal("private_key" in body, false);
  const listed = await fetch(`http://127.0.0.1:${address.port}/fleet`);
  assert.equal((await listed.json() as any).nodes[0].node_id, body.node_id);
  const revoked = await fetch(`http://127.0.0.1:${address.port}/fleet/${body.node_id}`, { method: "DELETE" });
  assert.equal(revoked.status, 204);
});

test("labels, users, keys, unknown fields, and immutable enrollment are validated", async (t) => {
  const { root, registry } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(() => registry.enroll({ ...enrollment("bad host", 1) }), (e: FleetError) => e.status === 400);
  await assert.rejects(() => registry.enroll({ ...enrollment("good", 1), ssh_user: "root;ouch" }), (e: FleetError) => e.status === 400);
  await assert.rejects(() => registry.enroll({ ...enrollment("good", 1), tunnel_public_key: "ssh-ed25519 AAAA" }), (e: FleetError) => e.status === 400);
  await assert.rejects(() => registry.enroll({ ...enrollment("good", 1), private_key: "secret" }), (e: FleetError) => e.status === 400);
  await registry.enroll(enrollment("good", 1));
  await assert.rejects(() => registry.enroll({ ...enrollment("changed", 1) }), (e: FleetError) => e.status === 409);
  await assert.rejects(() => registry.enroll(enrollment("good", 2)), (e: FleetError) => e.status === 409);
});

test("registry survives restart and emits pinned, restricted reconciliation artifacts", async (t) => {
  const { root, config, registry } = await fixture(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const enrolled = await registry.enroll(enrollment("laptop", 7));
  const restarted = new FleetRegistry(config);
  await restarted.initialize();
  assert.equal((await restarted.enroll(enrollment("laptop", 7))).node_id, enrolled.node_id);
  const authorized = await fs.readFile(path.join(root, "authorized_keys"), "utf8");
  assert.match(authorized, /^restrict,port-forwarding,command="\/bin\/false",permitlisten="127\.0\.0\.1:24000",permitlisten="\[::1\]:24000",permitopen="127\.0\.0\.1:24000",permitopen="\[::1\]:24000" ssh-ed25519 /);
  assert.doesNotMatch(authorized, /PRIVATE/);
  const route = await fs.readFile(path.join(root, "ssh_config"), "utf8");
  assert.match(route, /StrictHostKeyChecking yes/);
  assert.match(route, /HostKeyAlias familiar-fleet-fn_/);
  assert.match(route, /IdentityFile "\/run\/keys\/fleet-controller"/);
  const known = await fs.readFile(path.join(root, "known_hosts"), "utf8");
  assert.match(known, new RegExp(`familiar-fleet-${enrolled.node_id} ssh-ed25519`));
  const profiles = JSON.parse(await fs.readFile(path.join(root, "herdr-machines.json"), "utf8"));
  assert.deepEqual(profiles.machines[0], { node_id: enrolled.node_id, name: "laptop", ssh_alias: "familiar-fleet-laptop", session: "familiar-fleet" });
  assert.equal((await fs.stat(path.join(root, "registry.json"))).mode & 0o777, 0o600);
});

test("revocation removes access and routes, releases the port, but retains identity", async (t) => {
  const { root, registry } = await fixture(25000, 25000); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await registry.enroll(enrollment("old", 1));
  await registry.revoke(first.node_id);
  assert.equal((await registry.list()).length, 0);
  assert.equal(await fs.readFile(path.join(root, "authorized_keys"), "utf8"), "");
  await assert.rejects(() => registry.enroll(enrollment("old", 1)), (e: FleetError) => e.status === 410);
  const replacement = await registry.enroll(enrollment("new", 2));
  assert.equal(replacement.port, 25000);
  const stored = JSON.parse(await fs.readFile(path.join(root, "registry.json"), "utf8"));
  assert.equal(stored.nodes[0].revoked_at, "2026-09-21T12:00:00.000Z");
});
