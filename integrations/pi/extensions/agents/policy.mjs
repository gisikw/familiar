import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/** Per-route/per-node Agent availability policy.
 *
 * Identity is the exact enrolled `provider/model` string and the exact enrolled
 * machine id. Policy can only further restrict enrollment: it never authorizes
 * an unenrolled route, node, harness, provider or credential, and it holds no
 * credential, remote path or transport material.
 *
 *   effective(node) = !on ? "deny" : (overrides[node] ?? fallback)
 *
 * Absence is deny. Unknown/malformed persisted state refuses both enforcement
 * and mutation instead of silently permitting or erasing it. */
export const POLICY_LIMITS = Object.freeze({
  routes: 256,
  overridesPerRoute: 128,
  routeBytes: 256,
  nodeBytes: 128,
  fileBytes: 65536,
});
export const POLICY_FILE = "agent-policy.json";
/** Fixed same-process service for the foreground familiar-ui bridge. */
export const POLICY_SERVICE = Symbol.for("familiar.agent-policy.v1");
const STORE_SLOT = Symbol.for("familiar.agents.policy-store.v1");
export const POLICY_CHANGED_EVENT = "familiar:agent-policy-changed";

export function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
const invalid = (message) => policyError("invalid_request", message);
const unavailable = (message) => policyError("unavailable", message);

function boundedString(value, max, name) {
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value) > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw invalid(`invalid ${name}`);
  return value;
}
function exactKeys(value, keys, name) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    keys.some((k) => !(k in value)) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw invalid(`invalid ${name}`);
  return value;
}
const decisionValue = (value, name) => {
  if (value !== "allow" && value !== "deny") throw invalid(`invalid ${name}`);
  return value;
};

/** Deterministic on-disk form: routes sorted by exact route string, override
 * keys sorted, fixed key order, one trailing newline. */
export function serializePolicy(doc) {
  const routes = [...doc.routes]
    .sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0))
    .map((entry) => ({
      route: entry.route,
      on: entry.on,
      fallback: entry.fallback,
      overrides: Object.fromEntries(
        Object.keys(entry.overrides)
          .sort()
          .map((node) => [node, entry.overrides[node]]),
      ),
    }));
  return JSON.stringify({ version: 1, seq: doc.seq, routes }) + "\n";
}
export function revisionOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}
export const EMPTY_POLICY = Object.freeze({ version: 1, seq: 0, routes: [] });

/** Strict parse. Any unknown version, unknown field, duplicate exact route,
 * bound violation or type error refuses the whole document. */
export function parsePolicy(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw unavailable("Agent policy file is malformed; refusing to enforce or mutate it");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unavailable("Agent policy file is not a policy document");
  if (value.version !== 1)
    throw unavailable("Agent policy file has an unsupported version; refusing to enforce or mutate it");
  let doc;
  try {
    exactKeys(value, ["version", "seq", "routes"], "policy document");
    if (!Number.isSafeInteger(value.seq) || value.seq < 0)
      throw invalid("invalid policy sequence");
    if (!Array.isArray(value.routes) || value.routes.length > POLICY_LIMITS.routes)
      throw invalid("invalid policy route list");
    const seen = new Set();
    const routes = value.routes.map((entry) => {
      exactKeys(entry, ["route", "on", "fallback", "overrides"], "policy route");
      const route = boundedString(entry.route, POLICY_LIMITS.routeBytes, "route");
      if (seen.has(route)) throw invalid("duplicate exact route identity");
      seen.add(route);
      if (typeof entry.on !== "boolean") throw invalid("invalid route on flag");
      const fallback = decisionValue(entry.fallback, "route fallback");
      if (
        !entry.overrides ||
        typeof entry.overrides !== "object" ||
        Array.isArray(entry.overrides)
      )
        throw invalid("invalid route overrides");
      const keys = Object.keys(entry.overrides);
      if (keys.length > POLICY_LIMITS.overridesPerRoute)
        throw invalid("route override bound exceeded");
      const overrides = {};
      for (const node of keys)
        overrides[boundedString(node, POLICY_LIMITS.nodeBytes, "node")] =
          decisionValue(entry.overrides[node], "node override");
      return { route, on: entry.on, fallback, overrides };
    });
    doc = { version: 1, seq: value.seq, routes };
  } catch (error) {
    throw unavailable(
      `Agent policy file is invalid (${error.message}); refusing to enforce or mutate it`,
    );
  }
  return doc;
}

export function effectiveDecision(entry, node) {
  if (!entry || !entry.on) return "deny";
  const override = Object.prototype.hasOwnProperty.call(entry.overrides, node)
    ? entry.overrides[node]
    : undefined;
  return override ?? entry.fallback;
}

/** The single in-process owner/writer of the policy file. */
export class PolicyStore {
  constructor(path) {
    this.path = path;
  }
  install() {
    if (process[STORE_SLOT])
      throw new Error("Familiar Agents policy already has a process owner");
    process[STORE_SLOT] = this;
    return () => {
      if (process[STORE_SLOT] === this) delete process[STORE_SLOT];
    };
  }
  /** Read the exact persisted document. Known absence is an empty fail-closed
   * policy with a real revision, so a first mutation needs no hand-edit. */
  current() {
    let raw;
    try {
      const info = lstatSync(this.path);
      if (!info.isFile())
        throw unavailable("Agent policy path is not a regular file");
      if (info.size > POLICY_LIMITS.fileBytes)
        throw unavailable("Agent policy file exceeds its byte bound");
      const fd = openSync(this.path, "r");
      try {
        const buffer = Buffer.alloc(POLICY_LIMITS.fileBytes + 1);
        const read = readSync(fd, buffer, 0, buffer.length, 0);
        if (read > POLICY_LIMITS.fileBytes)
          throw unavailable("Agent policy file exceeds its byte bound");
        raw = buffer.subarray(0, read).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        const bytes = serializePolicy(EMPTY_POLICY);
        return {
          doc: { version: 1, seq: 0, routes: [] },
          revision: revisionOf(bytes),
          present: false,
        };
      }
      if (typeof error?.code === "string" && error.code.startsWith("E"))
        throw unavailable("Agent policy file is unreadable; refusing to enforce or mutate it");
      throw error;
    }
    const doc = parsePolicy(raw);
    // The revision is over the canonical bytes, so a byte-identical rewrite is
    // identical and every accepted mutation (seq) yields a new revision.
    return { doc, revision: revisionOf(serializePolicy(doc)), present: true };
  }
  entry(route) {
    return this.current().doc.routes.find((r) => r.route === route);
  }
  /** Enforcement. Throws `unavailable` for unreadable/unknown state; never
   * returns "allow" for absent state. */
  effective(route, node) {
    if (typeof route !== "string" || typeof node !== "string") return "deny";
    return effectiveDecision(this.entry(route), node);
  }
  write(doc) {
    const bytes = Buffer.from(serializePolicy(doc), "utf8");
    if (bytes.length > POLICY_LIMITS.fileBytes)
      throw invalid("Agent policy would exceed its byte bound");
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, bytes, 0, bytes.length, 0);
      fsyncSync(fd);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {}
      throw error;
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.path);
    try {
      const dirFd = openSync(directory, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {}
    return revisionOf(bytes);
  }
  /** Apply exactly one bounded mutation under compare-and-set. `enrollment`
   * is the truthful enrolled projection: policy may only restrict it. */
  mutate(expectedRevision, mutation, enrollment) {
    if (typeof expectedRevision !== "string" || !expectedRevision.length)
      throw invalid("expected revision required");
    const change = validateMutation(mutation);
    const nodes = enrollment?.nodes instanceof Map ? enrollment.nodes : new Map();
    const routes = new Set();
    for (const list of nodes.values()) for (const route of list) routes.add(route);
    if (!routes.has(change.route))
      throw invalid("route is not enrolled on any machine; policy cannot grant it");
    if (change.node !== undefined && !nodes.has(change.node))
      throw invalid("machine is not enrolled; policy cannot grant it");
    const state = this.current();
    if (state.revision !== expectedRevision)
      throw policyError("stale", "Agent policy revision is stale; re-read the snapshot");
    const list = state.doc.routes.map((entry) => ({
      ...entry,
      overrides: { ...entry.overrides },
    }));
    let entry = list.find((r) => r.route === change.route);
    if (!entry) {
      if (list.length >= POLICY_LIMITS.routes)
        throw invalid("policy route bound exceeded");
      // A new entry starts fail-closed; the mutation then applies to it.
      entry = { route: change.route, on: false, fallback: "deny", overrides: {} };
      list.push(entry);
    }
    switch (change.action) {
      case "set-on":
        // Turning a route off is non-destructive: fallback and overrides stay.
        entry.on = change.on;
        break;
      case "set-fallback":
        entry.fallback = change.fallback;
        break;
      case "set-override":
        if (
          !Object.prototype.hasOwnProperty.call(entry.overrides, change.node) &&
          Object.keys(entry.overrides).length >= POLICY_LIMITS.overridesPerRoute
        )
          throw invalid("route override bound exceeded");
        entry.overrides[change.node] = change.decision;
        break;
      case "clear-override":
        delete entry.overrides[change.node];
        break;
    }
    const next = { version: 1, seq: state.doc.seq + 1, routes: list };
    this.write(next);
    return this.snapshot(enrollment);
  }
  /** Browser-safe projection: exact ids only. No credential, remote path, SSH
   * configuration, token, owner handle or generic invocation crosses this. */
  snapshot(enrollment) {
    const state = this.current();
    const nodes = enrollment?.nodes instanceof Map ? enrollment.nodes : new Map();
    const reachability =
      enrollment?.reachability instanceof Map ? enrollment.reachability : new Map();
    return {
      version: 1,
      revision: state.revision,
      nodes: [...nodes.keys()]
        .sort()
        .slice(0, POLICY_LIMITS.routes)
        .map((id) => {
          const node = {
            id,
            routes: [...nodes.get(id)].sort().slice(0, POLICY_LIMITS.routes),
          };
          const known = reachability.get(id);
          if (known === "online" || known === "offline") node.reachability = known;
          return node;
        }),
      routes: state.doc.routes
        .map((entry) => ({
          route: entry.route,
          on: entry.on,
          fallback: entry.fallback,
          overrides: Object.fromEntries(
            Object.keys(entry.overrides)
              .sort()
              .map((node) => [node, entry.overrides[node]]),
          ),
        }))
        .sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0)),
    };
  }
}

/** The complete set of accepted mutations. There is no generic policy verb. */
export function validateMutation(mutation) {
  if (!mutation || typeof mutation !== "object" || Array.isArray(mutation))
    throw invalid("invalid policy mutation");
  switch (mutation.action) {
    case "set-on": {
      exactKeys(mutation, ["action", "route", "on"], "policy mutation");
      if (typeof mutation.on !== "boolean") throw invalid("on must be a boolean");
      return {
        action: "set-on",
        route: boundedString(mutation.route, POLICY_LIMITS.routeBytes, "route"),
        on: mutation.on,
      };
    }
    case "set-fallback": {
      exactKeys(mutation, ["action", "route", "fallback"], "policy mutation");
      return {
        action: "set-fallback",
        route: boundedString(mutation.route, POLICY_LIMITS.routeBytes, "route"),
        fallback: decisionValue(mutation.fallback, "fallback"),
      };
    }
    case "set-override": {
      exactKeys(mutation, ["action", "route", "node", "decision"], "policy mutation");
      return {
        action: "set-override",
        route: boundedString(mutation.route, POLICY_LIMITS.routeBytes, "route"),
        node: boundedString(mutation.node, POLICY_LIMITS.nodeBytes, "node"),
        decision: decisionValue(mutation.decision, "decision"),
      };
    }
    case "clear-override": {
      exactKeys(mutation, ["action", "route", "node"], "policy mutation");
      return {
        action: "clear-override",
        route: boundedString(mutation.route, POLICY_LIMITS.routeBytes, "route"),
        node: boundedString(mutation.node, POLICY_LIMITS.nodeBytes, "node"),
      };
    }
    default:
      throw invalid("unknown policy mutation action");
  }
}

/** Truthful enrolled projection from the Agents transport configuration. */
export function enrollmentOf(transport) {
  const nodes = new Map();
  for (const machine of transport?.config?.machines ?? [])
    nodes.set(machine.name, [...(machine.models ?? [])]);
  return { nodes };
}

export function policyFilePath(stateRoot) {
  return join(stateRoot, POLICY_FILE);
}
