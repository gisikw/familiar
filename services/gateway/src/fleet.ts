import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const REMOTE_SESSION = "familiar-fleet";
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SSH_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const NODE_ID = /^fn_[0-9a-f]{32}$/;

type Presence = { state: "online" | "offline" | "unknown"; observed_at: string | null };
type NodeRecord = {
  node_id: string;
  host: string;
  port: number;
  tunnel_public_key: string;
  ssh_host_public_key: string;
  ssh_user: string;
  enrolled_at: string;
  revoked_at?: string;
};
type RegistryDocument = { version: 1; nodes: NodeRecord[] };

export type FleetConfig = {
  stateDir: string;
  portMin: number;
  portMax: number;
  tunnelHost: string;
  tunnelSSHPort: number;
  tunnelUser: string;
  controllerPublicKey: string;
  controllerIdentityFile?: string;
  presencePath?: string;
  forcedCommand: string;
};

export class FleetError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function parsePort(value: string | undefined, fallback: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) throw new Error("fleet ports must be integers in 1..65535");
  return n;
}

export function fleetConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FleetConfig | undefined {
  if (!env.FAMILIAR_FLEET_STATE_DIR) return undefined;
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required when FAMILIAR_FLEET_STATE_DIR is set`);
    return value;
  };
  const portMin = parsePort(env.FAMILIAR_FLEET_PORT_MIN, 22000);
  const portMax = parsePort(env.FAMILIAR_FLEET_PORT_MAX, 22999);
  if (portMin > portMax) throw new Error("FAMILIAR_FLEET_PORT_MIN must not exceed FAMILIAR_FLEET_PORT_MAX");
  const tunnelSSHPort = parsePort(env.FAMILIAR_FLEET_TUNNEL_SSH_PORT, 22);
  const tunnelHost = required("FAMILIAR_FLEET_TUNNEL_HOST");
  if (!/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(tunnelHost) && !/^\[[0-9A-Fa-f:]+\]$/.test(tunnelHost)) {
    throw new Error("FAMILIAR_FLEET_TUNNEL_HOST is not a hostname or bracketed IPv6 address");
  }
  const tunnelUser = required("FAMILIAR_FLEET_TUNNEL_USER");
  if (!SSH_USER.test(tunnelUser)) throw new Error("FAMILIAR_FLEET_TUNNEL_USER is invalid");
  const controllerPublicKey = normalizeEd25519Key(required("FAMILIAR_FLEET_CONTROLLER_PUBLIC_KEY"), "controller public key");
  const forcedCommand = env.FAMILIAR_FLEET_FORCED_COMMAND?.trim() || "/bin/false";
  if (!/^\/[A-Za-z0-9._/-]+$/.test(forcedCommand)) throw new Error("FAMILIAR_FLEET_FORCED_COMMAND must be an absolute executable path without shell syntax");
  const controllerIdentityFile = env.FAMILIAR_FLEET_CONTROLLER_IDENTITY_FILE?.trim() || undefined;
  if (controllerIdentityFile && (!path.isAbsolute(controllerIdentityFile) || /["\r\n\0]/.test(controllerIdentityFile))) {
    throw new Error("FAMILIAR_FLEET_CONTROLLER_IDENTITY_FILE must be a safe absolute path");
  }
  return {
    stateDir: path.resolve(env.FAMILIAR_FLEET_STATE_DIR), portMin, portMax,
    tunnelHost, tunnelSSHPort, tunnelUser, controllerPublicKey, forcedCommand,
    controllerIdentityFile,
    presencePath: env.FAMILIAR_FLEET_PRESENCE_PATH?.trim() || undefined,
  };
}

function readSSHString(blob: Buffer, offset: number): { value: Buffer; next: number } {
  if (offset + 4 > blob.length) throw new Error("truncated SSH key");
  const size = blob.readUInt32BE(offset);
  const next = offset + 4 + size;
  if (size > 4096 || next > blob.length) throw new Error("invalid SSH key field");
  return { value: blob.subarray(offset + 4, next), next };
}

export function normalizeEd25519Key(input: unknown, field = "SSH key"): string {
  if (typeof input !== "string" || input.length > 2048 || /[\r\n\0]/.test(input)) throw new FleetError(400, `${field} is invalid`);
  const parts = input.trim().split(/[ \t]+/);
  if (parts.length < 2 || parts[0] !== "ssh-ed25519" || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) throw new FleetError(400, `${field} must be an ssh-ed25519 public key`);
  let blob: Buffer;
  try { blob = Buffer.from(parts[1], "base64"); } catch { throw new FleetError(400, `${field} has invalid base64`); }
  if (blob.toString("base64").replace(/=+$/, "") !== parts[1].replace(/=+$/, "")) throw new FleetError(400, `${field} has non-canonical base64`);
  try {
    const algorithm = readSSHString(blob, 0);
    const key = readSSHString(blob, algorithm.next);
    if (algorithm.value.toString("ascii") !== "ssh-ed25519" || key.value.length !== 32 || key.next !== blob.length) throw new Error("shape");
  } catch { throw new FleetError(400, `${field} is not a valid Ed25519 SSH key`); }
  return `ssh-ed25519 ${parts[1]}`;
}

function canonicalHost(input: unknown): string {
  if (typeof input !== "string") throw new FleetError(400, "host is required");
  const host = input.trim().toLowerCase();
  if (!LABEL.test(host)) throw new FleetError(400, "host must be a 1-63 character DNS label");
  return host;
}

function validateEnrollment(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FleetError(400, "request body must be an object");
  const body = value as Record<string, unknown>;
  const expected = new Set(["host", "tunnel_public_key", "ssh_host_public_key", "ssh_user"]);
  for (const key of Object.keys(body)) if (!expected.has(key)) throw new FleetError(400, `unknown field ${key}`);
  if (typeof body.ssh_user !== "string" || !SSH_USER.test(body.ssh_user)) throw new FleetError(400, "ssh_user is invalid");
  return {
    host: canonicalHost(body.host),
    tunnel_public_key: normalizeEd25519Key(body.tunnel_public_key, "tunnel_public_key"),
    ssh_host_public_key: normalizeEd25519Key(body.ssh_host_public_key, "ssh_host_public_key"),
    ssh_user: body.ssh_user,
  };
}

async function atomicWrite(file: string, data: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", mode);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close(); handle = undefined;
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export class FleetRegistry {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly config: FleetConfig, private now = () => new Date().toISOString()) {}

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    const lock = path.join(this.config.stateDir, ".registry.lock");
    let held = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await fs.mkdir(lock, { mode: 0o700 });
        await fs.writeFile(path.join(lock, "pid"), `${process.pid}\n`, { mode: 0o600 });
        held = true; break;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        // mkdir locks survive SIGKILL. Reap one only when its recorded local
        // owner is definitely gone; EPERM means the process still exists.
        try {
          const owner = Number((await fs.readFile(path.join(lock, "pid"), "utf8")).trim());
          if (Number.isSafeInteger(owner) && owner > 1) {
            try { process.kill(owner, 0); }
            catch (probe: any) { if (probe?.code === "ESRCH") await fs.rm(lock, { recursive: true, force: true }); }
          }
        } catch { /* creator may not have published its pid yet */ }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!held) throw new FleetError(503, "fleet registry is busy");
    try { return await operation(); }
    finally { await fs.rm(lock, { recursive: true, force: true }).catch(() => {}); }
  }

  async initialize(): Promise<void> {
    await this.serialized(() => this.withFileLock(async () => {
      await fs.chmod(this.config.stateDir, 0o700);
      const registry = await this.load();
      await this.reconcile(registry);
    }));
  }

  private async load(): Promise<RegistryDocument> {
    try {
      const raw = await fs.readFile(path.join(this.config.stateDir, "registry.json"), "utf8");
      const value = JSON.parse(raw) as RegistryDocument;
      if (value.version !== 1 || !Array.isArray(value.nodes)) throw new Error("unsupported registry document");
      const ids = new Set<string>(); const keys = new Set<string>();
      const activeHosts = new Set<string>(); const activePorts = new Set<number>();
      for (const node of value.nodes) {
        if (!NODE_ID.test(node.node_id) || !LABEL.test(node.host) || !Number.isInteger(node.port)) throw new Error("invalid registry record");
        normalizeEd25519Key(node.tunnel_public_key); normalizeEd25519Key(node.ssh_host_public_key);
        if (!SSH_USER.test(node.ssh_user) || ids.has(node.node_id) || keys.has(node.tunnel_public_key)) throw new Error("invalid or duplicate registry identity");
        ids.add(node.node_id); keys.add(node.tunnel_public_key);
        if (!node.revoked_at) {
          if (node.port < this.config.portMin || node.port > this.config.portMax || activeHosts.has(node.host) || activePorts.has(node.port)) throw new Error("active registry assignment is invalid or duplicated");
          activeHosts.add(node.host); activePorts.add(node.port);
        }
      }
      return value;
    } catch (error: any) {
      if (error?.code === "ENOENT") return { version: 1, nodes: [] };
      throw new Error(`cannot load fleet registry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private assignment(node: NodeRecord) {
    return {
      node_id: node.node_id, host: node.host, port: node.port,
      tunnel_host: this.config.tunnelHost, tunnel_ssh_port: this.config.tunnelSSHPort,
      tunnel_user: this.config.tunnelUser, remote_session: REMOTE_SESSION,
      controller_public_key: this.config.controllerPublicKey,
    };
  }

  async enroll(value: unknown) {
    const request = validateEnrollment(value);
    return this.serialized(() => this.withFileLock(async () => {
      const registry = await this.load();
      const prior = registry.nodes.find((node) => node.tunnel_public_key === request.tunnel_public_key);
      if (prior) {
        if (prior.revoked_at) throw new FleetError(410, "this node identity has been revoked");
        if (prior.host !== request.host || prior.ssh_host_public_key !== request.ssh_host_public_key || prior.ssh_user !== request.ssh_user) {
          throw new FleetError(409, "enrolled key is already bound to different node attributes");
        }
        // Also repairs generated material if a prior process stopped between
        // committing registry.json and completing reconciliation.
        await this.reconcile(registry);
        return this.assignment(prior);
      }
      if (registry.nodes.some((node) => !node.revoked_at && node.host === request.host)) throw new FleetError(409, "host is already enrolled");
      const used = new Set(registry.nodes.filter((node) => !node.revoked_at).map((node) => node.port));
      let port: number | undefined;
      for (let candidate = this.config.portMin; candidate <= this.config.portMax; candidate++) if (!used.has(candidate)) { port = candidate; break; }
      if (port === undefined) throw new FleetError(503, "fleet port range is exhausted");
      const node: NodeRecord = { ...request, port, node_id: `fn_${crypto.randomBytes(16).toString("hex")}`, enrolled_at: this.now() };
      registry.nodes.push(node);
      await this.persistAndReconcile(registry);
      return this.assignment(node);
    }));
  }

  async revoke(nodeID: string): Promise<void> {
    if (!NODE_ID.test(nodeID)) throw new FleetError(404, "node not found");
    await this.serialized(() => this.withFileLock(async () => {
      const registry = await this.load();
      const node = registry.nodes.find((item) => item.node_id === nodeID);
      if (!node) throw new FleetError(404, "node not found");
      if (!node.revoked_at) { node.revoked_at = this.now(); await this.persistAndReconcile(registry); }
      else await this.reconcile(registry);
    }));
  }

  async list() {
    const registry = await this.serialized(() => this.load());
    const presence = await this.readPresence();
    return registry.nodes.filter((node) => !node.revoked_at).map((node) => ({
      ...this.assignment(node), enrolled_at: node.enrolled_at,
      presence: presence[node.node_id] ?? { state: "unknown", observed_at: null },
    }));
  }

  private async readPresence(): Promise<Record<string, Presence>> {
    if (!this.config.presencePath) return {};
    try {
      const parsed = JSON.parse(await fs.readFile(this.config.presencePath, "utf8")) as Record<string, Presence>;
      const result: Record<string, Presence> = {};
      for (const [id, value] of Object.entries(parsed)) {
        if (NODE_ID.test(id) && value && ["online", "offline", "unknown"].includes(value.state) && (value.observed_at === null || typeof value.observed_at === "string")) result[id] = value;
      }
      return result;
    } catch { return {}; }
  }

  private async persistAndReconcile(registry: RegistryDocument): Promise<void> {
    await atomicWrite(path.join(this.config.stateDir, "registry.json"), JSON.stringify(registry, null, 2) + "\n");
    await this.reconcile(registry);
  }

  private async reconcile(registry: RegistryDocument): Promise<void> {
    const active = registry.nodes.filter((node) => !node.revoked_at).sort((a, b) => a.host.localeCompare(b.host));
    const authorized = active.map((node) =>
      `restrict,port-forwarding,command="${this.config.forcedCommand}",permitlisten="127.0.0.1:${node.port}",permitlisten="[::1]:${node.port}",permitopen="127.0.0.1:${node.port}",permitopen="[::1]:${node.port}" ${node.tunnel_public_key} familiar-fleet:${node.node_id}`
    ).join("\n") + (active.length ? "\n" : "");
    const knownHosts = active.map((node) => `familiar-fleet-${node.node_id} ${node.ssh_host_public_key}`).join("\n") + (active.length ? "\n" : "");
    const routes = active.map((node) => [
      `Host familiar-fleet-${node.host}`,
      "  HostName 127.0.0.1", `  Port ${node.port}`, `  User ${node.ssh_user}`,
      `  HostKeyAlias familiar-fleet-${node.node_id}`,
      `  UserKnownHostsFile "${path.join(this.config.stateDir, "known_hosts").replaceAll('"', '\\"')}"`,
      "  StrictHostKeyChecking yes", "  CheckHostIP no", "  IdentitiesOnly yes",
      ...(this.config.controllerIdentityFile ? [`  IdentityFile "${this.config.controllerIdentityFile.replaceAll('"', '\\"')}"`] : []),
    ].join("\n")).join("\n\n") + (active.length ? "\n" : "");
    const profiles = {
      version: 1, generated_at: this.now(), remote_session: REMOTE_SESSION,
      machines: active.map((node) => ({ node_id: node.node_id, name: node.host, ssh_alias: `familiar-fleet-${node.host}`, session: REMOTE_SESSION })),
    };
    await atomicWrite(path.join(this.config.stateDir, "authorized_keys"), authorized);
    await atomicWrite(path.join(this.config.stateDir, "known_hosts"), knownHosts);
    await atomicWrite(path.join(this.config.stateDir, "ssh_config"), routes);
    await atomicWrite(path.join(this.config.stateDir, "herdr-machines.json"), JSON.stringify(profiles, null, 2) + "\n");
  }
}

async function readJSON(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk); size += buffer.length;
    if (size > 16 * 1024) throw new FleetError(413, "request body is too large");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new FleetError(400, "request body is not valid JSON"); }
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value) + "\n");
}

export async function handleFleet(registry: FleetRegistry, req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
  if (pathname === "/fleet") {
    if (req.method === "POST") { json(res, 200, await registry.enroll(await readJSON(req))); return true; }
    if (req.method === "GET") { json(res, 200, { nodes: await registry.list() }); return true; }
    res.setHeader("Allow", "GET, POST"); json(res, 405, { error: "method not allowed" }); return true;
  }
  const match = /^\/fleet\/(fn_[0-9a-f]{32})$/.exec(pathname);
  if (match) {
    if (req.method !== "DELETE") { res.setHeader("Allow", "DELETE"); json(res, 405, { error: "method not allowed" }); return true; }
    await registry.revoke(match[1]); res.statusCode = 204; res.end(); return true;
  }
  return pathname.startsWith("/fleet/") ? (json(res, 404, { error: "node not found" }), true) : false;
}
