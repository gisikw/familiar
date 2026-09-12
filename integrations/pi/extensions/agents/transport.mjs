import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { LIMITS, text, modelSelection } from "./contract.mjs";

const script = readFileSync(new URL("./remote.py", import.meta.url), "utf8");
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
export function boundedExec(binary, args, input, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
      env: Object.fromEntries(
        ["PATH", "HOME", "LANG", "SSH_AUTH_SOCK"]
          .filter((k) => process.env[k] !== undefined)
          .map((k) => [k, process.env[k]]),
      ),
    });
    let chunks = [],
      size = 0,
      failed = false;
    const fail = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(fail, LIMITS.callMs);
    child.stdout.on("data", (b) => {
      size += b.length;
      if (size > LIMITS.response) fail();
      else chunks.push(b);
    });
    // Count and discard stderr: it can contain credentials or arbitrary remote output.
    child.stderr.on("data", (b) => {
      size += b.length;
      if (size > LIMITS.response) fail();
    });
    child.on("error", () => {
      // Node's abort path sends SIGTERM, which a stuck child may ignore. Do not
      // clear the only deadline while leaving that local transport child alive.
      failed = true;
      child.kill("SIGKILL");
      clearTimeout(timer);
      reject(new Error("native route unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0)
        reject(new Error("native route failed or timed out; outcome unknown"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
function hostKey(value) {
  text(value, 1024, "host key");
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(value))
    throw new Error("explicit ed25519 host key required");
  return value.split(" ").slice(0, 2).join(" ");
}
export function writePinnedRoute(config, m, root) {
  const pins = join(root, `${m.name}.known_hosts`),
    route = join(root, `${m.name}.ssh`);
  const atomic = (path, data) => {
    const temp = path + "." + randomUUID();
    writeFileSync(temp, data, { mode: 0o600 });
    renameSync(temp, path);
  };
  atomic(
    pins,
    `drover-${m.name} ${hostKey(m.host_key)}\nfamiliar-drover-jump ${hostKey(m.jump.host_key)}\n`,
  );
  const trust = `  UserKnownHostsFile ${JSON.stringify(pins)}\n  GlobalKnownHostsFile /dev/null\n  StrictHostKeyChecking yes\n  VerifyHostKeyDNS no\n  KnownHostsCommand none\n  CheckHostIP no\n  PermitLocalCommand no\n  UpdateHostKeys no\n  HostKeyAlgorithms ssh-ed25519\n  BatchMode yes\n  ForwardAgent no\n  ClearAllForwardings yes\n  ControlMaster no\n  ControlPath none\n  ControlPersist no\n  CanonicalizeHostname no\n  RequestTTY no\n  RemoteCommand none\n`;
  atomic(
    route,
    `Host ${m.ssh_alias}\n  HostName 127.0.0.1\n  Port ${m.port}\n  User ${m.ssh_user}\n  HostKeyAlias drover-${m.name}\n  ProxyJump ${m.jump.alias}\n${trust}Host ${m.jump.alias}\n  HostName ${m.jump.hostname}\n  Port ${m.jump.port}\n  User ${m.jump.user}\n  HostKeyAlias familiar-drover-jump\n  ProxyJump none\n${trust}Host *\n  Include ${config.ssh_config}\n`,
  );
  return route;
}
export function boundedFile(file, max) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile())
      throw new Error("configuration must be a regular file");
    const bytes = Buffer.alloc(max + 1);
    const n = readSync(fd, bytes, 0, bytes.length, 0);
    if (n > max) throw new Error("configuration file bound");
    return bytes.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function clientToken(file) {
  const value = boundedFile(file, 8192).trim();
  if (!/^[\x21-\x7e]{32,4096}$/.test(value))
    throw new Error("invalid Drover token file");
  return value;
}
export function workerProfileBundle() {
  // Fixed source-code allowlist, never a controller profile/auth directory.
  return Object.fromEntries(
    [
      "tiamat/index.ts",
      "tiamat/catalog.ts",
      "tiamat/materializer.ts",
      "tiamat/usage.ts",
      "lib/debug.ts",
    ].map((name) => [
      name,
      readFileSync(new URL("../" + name, import.meta.url), "utf8"),
    ]),
  );
}
export function configuration(file) {
  if (!file)
    throw new Error("FAMILIAR_AGENTS_CONFIG is required; no local fallback");
  if (!file.startsWith("/"))
    throw new Error("absolute Agents configuration path required");
  const c = JSON.parse(boundedFile(file, 131072));
  if (
    !c ||
    Array.isArray(c) ||
    Object.keys(c).some(
      (k) =>
        ![
          "url",
          "token_file",
          "ssh_config",
          "jump",
          "machines",
          "remote_retention_days",
          "idle_grace_ms",
        ].includes(k),
    )
  )
    throw new Error("unknown Agents configuration field");
  const u = new URL(c.url);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
    )
  )
    throw new Error("invalid Drover URL");
  text(c.token_file, 4096);
  if (!c.token_file.startsWith("/"))
    throw new Error("absolute Drover token-file reference required");
  clientToken(c.token_file);
  text(c.ssh_config, 4096);
  if (!c.ssh_config.startsWith("/") || /[\s"\\]/.test(c.ssh_config))
    throw new Error("SSH config requires an absolute, whitespace-free path");
  const jump = c.jump;
  if (
    !jump ||
    !/^[-a-zA-Z0-9.]+$/.test(jump.hostname) ||
    !/^[-a-zA-Z0-9_]+$/.test(jump.alias) ||
    !/^[-a-zA-Z0-9_]+$/.test(jump.user) ||
    !Number.isInteger(jump.port) ||
    jump.port < 1 ||
    jump.port > 65535
  )
    throw new Error("explicit Drover jump identity required");
  if (
    Object.keys(jump).some(
      (k) => !["hostname", "alias", "user", "port", "host_key"].includes(k),
    )
  )
    throw new Error("unknown jump configuration field");
  text(jump.hostname, 253, "jump host");
  text(jump.alias, 128, "jump alias");
  text(jump.user, 128, "jump user");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(jump.alias))
    throw new Error("invalid jump alias");
  hostKey(jump.host_key);
  if (!Array.isArray(c.machines) || c.machines.length > 64)
    throw new Error("invalid enrollment configuration");
  if (new Set(c.machines.map((m) => m.name)).size !== c.machines.length)
    throw new Error("duplicate machine enrollment");
  if (
    c.idle_grace_ms !== undefined &&
    (!Number.isInteger(c.idle_grace_ms) ||
      c.idle_grace_ms < 1000 ||
      c.idle_grace_ms > 86400000)
  )
    throw new Error("invalid idle grace");
  for (const m of c.machines) {
    if (
      !m ||
      Array.isArray(m) ||
      Object.keys(m).some(
        (k) =>
          ![
            "name",
            "session",
            "host_key",
            "ssh_user",
            "port",
            "ssh_alias",
            "profile",
            "profile_mode",
            "herdr_binary",
            "python_binary",
            "models",
            "worker_env",
            "capture_terminal_context",
          ].includes(k),
      )
    )
      throw new Error("unknown enrollment configuration field");
    if (
      m.capture_terminal_context !== undefined &&
      typeof m.capture_terminal_context !== "boolean"
    )
      throw new Error("invalid terminal context policy");
    if (
      !/^[a-z][a-z0-9-]{0,47}$/.test(m.name) ||
      !/^[a-z][a-z0-9-]*$/.test(m.session)
    )
      throw new Error("invalid enrolled identity");
    hostKey(m.host_key);
    text(m.ssh_user, 128);
    if (![undefined, "enrolled", "familiar-tiamat-v1"].includes(m.profile_mode))
      throw new Error("unsupported worker profile mode");
    if (m.profile_mode !== "familiar-tiamat-v1") text(m.profile, 4096);
    else if (
      !m.worker_env?.FAMILIAR_TIAMAT_URL ||
      !m.worker_env?.FAMILIAR_TIAMAT_TOKEN_FILE?.startsWith("/")
    )
      throw new Error(
        "generated Tiamat profile requires explicit enrolled URL and absolute remote token-file reference",
      );
    text(m.ssh_alias, 128);
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(m.ssh_alias) ||
      !/^[_a-zA-Z0-9][_a-zA-Z0-9-]*$/.test(m.ssh_user)
    )
      throw new Error("invalid SSH identity");
    text(m.herdr_binary, 4096);
    if (
      m.python_binary !== undefined &&
      (!m.python_binary.startsWith("/") ||
        m.python_binary.length > 4096 ||
        m.python_binary.includes("\0"))
    )
      throw new Error("invalid explicit Python binary");
    if (!m.herdr_binary.startsWith("/"))
      throw new Error("explicit pinned Herdr binary required");
    if (
      !Number.isSafeInteger(m.port) ||
      m.port < 1 ||
      m.port > 65535 ||
      (m.profile_mode !== "familiar-tiamat-v1" && !m.profile.startsWith("/"))
    )
      throw new Error("invalid enrolled route/profile");
    if (
      !Array.isArray(m.models) ||
      m.models.length > 100 ||
      m.models.some((x) => typeof x !== "string" || x.length > 256)
    )
      throw new Error("invalid enrolled models");
    for (const model of m.models) modelSelection(model);
  }
  if (
    c.remote_retention_days !== undefined &&
    (!Number.isInteger(c.remote_retention_days) ||
      c.remote_retention_days < 0 ||
      c.remote_retention_days > 3650)
  )
    throw new Error("invalid retention period");
  for (const m of c.machines) {
    if (
      m.worker_env?.FAMILIAR_TIAMAT_TOKEN_FILE &&
      !m.worker_env.FAMILIAR_TIAMAT_TOKEN_FILE.startsWith("/")
    )
      throw new Error("absolute remote token-file reference required");
    if (m.worker_env?.FAMILIAR_TIAMAT_URL) {
      const u = new URL(m.worker_env.FAMILIAR_TIAMAT_URL);
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash
      )
        throw new Error("invalid enrolled Tiamat URL");
    }
    if (
      m.worker_env !== undefined &&
      (!m.worker_env ||
        typeof m.worker_env !== "object" ||
        Object.entries(m.worker_env).some(
          ([k, v]) =>
            ![
              "PATH",
              "FAMILIAR_TIAMAT_URL",
              "FAMILIAR_TIAMAT_TOKEN_FILE",
            ].includes(k) ||
            typeof v !== "string" ||
            v.length > 4096 ||
            v.includes("\0"),
        ))
    )
      throw new Error("invalid explicit worker environment");
  }
  return c;
}
export class Transport {
  constructor(config, stateDir) {
    this.config = config;
    if (!stateDir)
      throw new Error("private transport state directory required");
    this.stateDir = stateDir;
    this.profileBundle = workerProfileBundle();
    this.modelGuard = readFileSync(
      new URL("./model-guard.ts", import.meta.url),
      "utf8",
    );
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
  admissionReady() {
    clientToken(this.config.token_file);
  }
  enrolled(id) {
    const m = this.config.machines.find((m) => m.name === id);
    if (!m)
      throw new Error("machine is not explicitly enrolled; no local fallback");
    return {
      ...m,
      profile_mode: m.profile_mode ?? "enrolled",
      model_guard_source: this.modelGuard,
      ...(m.profile_mode === "familiar-tiamat-v1"
        ? { profile_bundle: this.profileBundle }
        : {}),
      jump: this.config.jump,
    };
  }
  async http(path, body, signal, expectedPort) {
    const timeout = AbortSignal.timeout(LIMITS.callMs);
    const token = clientToken(this.config.token_file);
    const r = await fetch(this.config.url.replace(/\/$/, "") + path, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(expectedPort === undefined
          ? {}
          : { "If-Match": JSON.stringify(String(expectedPort)) }),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([signal, timeout]),
    });
    if (
      !r.ok ||
      (expectedPort !== undefined &&
        r.headers.get("etag") !== JSON.stringify(String(expectedPort)))
    ) {
      await r.body?.cancel();
      throw new Error("Drover route unavailable; outcome unknown");
    }
    const reader = r.body.getReader();
    let n = 0,
      chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > LIMITS.response) throw new Error("Drover response bound");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  async identity(job, signal) {
    const catalog = await this.http("/v1/machines", null, signal);
    if (!Array.isArray(catalog) || catalog.length > 1024)
      throw new Error("invalid catalog");
    const m = catalog.find((m) => m.name === job.machine_id),
      expected = job.machine_identity;
    if (!m) return false;
    for (const key of ["name", "session", "host_key", "port", "ssh_user"])
      if (m[key] !== expected[key])
        throw new Error("machine identity/session mismatch");
    if (m.online !== true) return false;
    const ping = await this.rpc(job, "ping", {}, signal);
    if (ping.version !== "0.9.0" || ping.protocol !== 22)
      throw new Error("pinned Herdr 0.9.0/protocol 22 required");
    return true;
  }
  async rpc(job, method, params, signal) {
    const v = await this.http(
      `/v1/machines/${job.machine_id}/rpc`,
      { method, params },
      signal,
      job.machine_identity.port,
    );
    if (v.error)
      throw new Error("Herdr operation rejected; inspect native workspace");
    if (!v.result) throw new Error("invalid Herdr response");
    return v.result;
  }
  async native(job, data, signal) {
    const m = this.enrolled(job.machine_id);
    for (const k of [
      "name",
      "session",
      "host_key",
      "port",
      "ssh_user",
      "ssh_alias",
      "profile",
      "python_binary",
      "profile_mode",
    ])
      if (m[k] !== job.machine_identity[k])
        throw new Error("enrollment changed; explicit reconciliation required");
    if (JSON.stringify(m.jump) !== JSON.stringify(job.machine_identity.jump))
      throw new Error("Drover jump enrollment changed");
    const route = writePinnedRoute(this.config, m, this.stateDir);
    // The overlay pins BOTH machine and coordinator-jump keys, and exact route
    // coordinates. Existing operator SSH config supplies authentication only.
    const args = [
      "-F",
      route,
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=10",
    ];
    const effective = await boundedExec(
      "ssh",
      [...args, "-G", m.ssh_alias],
      "",
      signal,
    );
    const opts = Object.fromEntries(
      effective
        .trim()
        .split("\n")
        .map((line) => {
          const i = line.indexOf(" ");
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    if (
      opts.hostname !== "127.0.0.1" ||
      Number(opts.port) !== m.port ||
      opts.user !== m.ssh_user ||
      opts.hostkeyalias !== `drover-${m.name}` ||
      opts.proxyjump !== m.jump.alias
    )
      throw new Error("native Drover route mismatch");
    const raw = await boundedExec(
      "ssh",
      [
        ...args,
        m.ssh_alias,
        `${quote(m.python_binary ?? "python3")} -c ${quote(script)}`,
      ],
      JSON.stringify(data),
      signal,
    );
    const result = JSON.parse(raw);
    if (result.error) throw new Error("native operation failed");
    return result;
  }
  plan(job, signal) {
    return this.provision(job, signal, "plan");
  }
  provision(job, signal, operation = "provision") {
    return this.native(
      job,
      {
        operation,
        settlement_path: job.settlement_path,
        resolved_head: job.resolved_head,
        remote_profile: job.remote_profile,
        profile_digest: job.profile_digest,
        job_id: job.job_id,
        nonce: job.settlement_nonce,
        repo: job.repo,
        ref: job.requested_ref,
        profile: job.machine_identity.profile,
        profile_mode: job.machine_identity.profile_mode ?? "enrolled",
        model_guard_source: job.machine_identity.model_guard_source,
        ...(job.machine_identity.profile_mode === "familiar-tiamat-v1"
          ? { profile_bundle: job.machine_identity.profile_bundle }
          : {}),
        herdr: job.machine_identity.herdr_binary,
      },
      signal,
    );
  }
  readSettlement(job, signal) {
    return this.native(
      job,
      { operation: "read", path: job.settlement_path },
      signal,
    );
  }
}
