import { createRequire } from "node:module";
import { mkdirSync, chmodSync, readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
// A shared local path across containers must not mistake a foreign PID for dead.
const PID_NAMESPACE = (() => {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
})();
const HOST = hostname() + ":" + PID_NAMESPACE;
const BOOT = (() => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
})();
function definitelyDead(lease) {
  if (lease.owner_host !== HOST) return false;
  if (BOOT && lease.owner_boot && BOOT !== lease.owner_boot) return true;
  if (!Number.isInteger(lease.owner_pid) || lease.owner_pid <= 0) return false;
  try {
    process.kill(lease.owner_pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}
import { dirname } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { LIMITS, digest, terminal, text } from "./contract.mjs";

/** All transactions are synchronous, short and local. Never await in a transaction. */
export class Ledger {
  constructor(file, now = Date.now) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.now = now;
    try {
      this.db.exec("PRAGMA busy_timeout=1000");
      this.tx(() => {
        if (
          this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE name='schema_version'")
            .get()
        ) {
          const versions = this.db
            .prepare("SELECT version FROM schema_version")
            .all();
          if (versions.length !== 1 || versions[0].version !== 1)
            throw new Error("unsupported agents ledger version");
          const columns = this.db
            .prepare("PRAGMA table_info(lease)")
            .all()
            .map((c) => c.name);
          if (
            columns.length &&
            !["owner_pid", "owner_host", "owner_boot"].every((c) =>
              columns.includes(c),
            )
          )
            throw new Error("unsupported pre-release Agents lease schema");
        }
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, generation INTEGER NOT NULL, expires INTEGER NOT NULL, owner_pid INTEGER, owner_host TEXT, owner_boot TEXT);
      INSERT OR IGNORE INTO lease(id,owner,generation,expires) VALUES(1,NULL,0,0);
      CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, admission_key TEXT UNIQUE NOT NULL, request_digest TEXT NOT NULL,
        machine_id TEXT NOT NULL, semantic_state TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, body TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(semantic_state);
      CREATE INDEX IF NOT EXISTS notifications_pending ON notifications(delivered);
      CREATE INDEX IF NOT EXISTS jobs_retention ON jobs(json_extract(data,'$.cleanup_state'),json_extract(data,'$.retained_tombstone'),json_extract(data,'$.updated_at'));`);
      });
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  acquire(owner) {
    return this.tx(() => {
      const l = this.db.prepare("SELECT * FROM lease WHERE id=1").get();
      if (l.expires > this.now() && !definitelyDead(l)) return null;
      const fence = { owner, generation: l.generation + 1 };
      this.db
        .prepare(
          "UPDATE lease SET owner=?,generation=?,expires=?,owner_pid=?,owner_host=?,owner_boot=? WHERE id=1",
        )
        .run(
          owner,
          fence.generation,
          this.now() + LIMITS.leaseMs,
          process.pid,
          HOST,
          BOOT,
        );
      return fence;
    });
  }
  check(fence) {
    const l = this.db.prepare("SELECT * FROM lease WHERE id=1").get();
    if (
      !fence ||
      l.owner !== fence.owner ||
      l.generation !== fence.generation ||
      l.expires <= this.now()
    )
      throw new Error("agents owner lease lost");
  }
  renew(fence) {
    this.tx(() => {
      this.check(fence);
      this.db
        .prepare("UPDATE lease SET expires=? WHERE id=1")
        .run(this.now() + LIMITS.leaseMs);
    });
  }
  release(fence) {
    this.db
      .prepare(
        "UPDATE lease SET expires=0 WHERE id=1 AND owner=? AND generation=?",
      )
      .run(fence.owner, fence.generation);
  }
  get(id) {
    const r = this.db
      .prepare("SELECT data,revision FROM jobs WHERE job_id=?")
      .get(id);
    return r ? { ...JSON.parse(r.data), revision: r.revision } : null;
  }
  rows(sql, ...args) {
    return this.db
      .prepare(sql)
      .all(...args)
      .map((r) => ({ ...JSON.parse(r.data), revision: r.revision }));
  }
  list(limit = 100, offset = 0) {
    return this.rows(
      "SELECT data,revision FROM jobs ORDER BY rowid DESC LIMIT ? OFFSET ?",
      Math.min(100, limit),
      offset,
    );
  }
  count() {
    return this.db.prepare("SELECT count(*) AS n FROM jobs").get().n;
  }
  active() {
    return this.rows(
      "SELECT data,revision FROM jobs WHERE semantic_state IN ('requested','provisioning','running','blocked','idle_unsettled','cancel_requested') OR json_extract(data,'$.cleanup_state')='requested' ORDER BY semantic_state IN ('settled','abandoned','failed_admission'), rowid LIMIT 64",
    );
  }
  admit(fence, request, machine, provenance) {
    for (const k of [
      "key",
      "machine_id",
      "harness",
      "model",
      "repo",
      "requested_ref",
      "task",
      "label",
    ])
      text(
        request[k],
        k === "task" ? LIMITS.task : k === "repo" ? 4096 : 256,
        k,
      );
    if (
      !request.repo.startsWith("/") ||
      /[\u0000-\u001f\u007f-\u009f]/.test(request.repo + request.requested_ref)
    )
      throw new Error(
        "absolute remote repository and control-free ref/path required",
      );
    text(provenance, 256, "owner provenance");
    const options = request.options ?? {};
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some((k) => k !== "thinking") ||
      (options.thinking !== undefined &&
        !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          options.thinking,
        ))
    )
      throw new Error("unsupported harness options");
    const hash = digest(
      JSON.stringify(
        Object.fromEntries(
          [
            "key",
            "machine_id",
            "harness",
            "model",
            "repo",
            "requested_ref",
            "task",
            "label",
          ]
            .map((k) => [k, request[k]])
            .concat(
              options.thinking === undefined
                ? []
                : [["options", { thinking: options.thinking }]],
            ),
        ),
      ),
    );
    return this.tx(() => {
      this.check(fence);
      const prior = this.db
        .prepare("SELECT job_id,request_digest FROM jobs WHERE admission_key=?")
        .get(request.key);
      if (prior) {
        if (prior.request_digest !== hash)
          throw new Error("admission key reused with different request");
        return this.get(prior.job_id);
      }
      const active = this.active().filter((j) => !terminal(j));
      if (
        active.length >= LIMITS.active ||
        active.filter((j) => j.machine_id === request.machine_id).length >=
          LIMITS.perMachine
      )
        throw new Error("active job limit");
      const now = this.now(),
        id = `agent-${randomUUID()}`;
      const slug = BigInt("0x" + id.slice(6).replaceAll("-", "")).toString(36);
      const j = {
        job_id: id,
        admission_key: request.key,
        settlement_nonce: randomBytes(32).toString("hex"),
        created_at: now,
        updated_at: now,
        machine_id: request.machine_id,
        machine_identity: machine,
        herdr_session: machine.session,
        herdr_workspace_id: null,
        herdr_agent_id: null,
        herdr_agent_name: `fa-${slug}`,
        repo: request.repo,
        requested_ref: request.requested_ref,
        remote_worktree: null,
        settlement_path: null,
        harness: request.harness,
        model: request.model,
        options:
          options.thinking === undefined ? {} : { thinking: options.thinking },
        label: `familiar/${slug} — ${request.label.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 80)}`,
        prompt_digest: digest(request.task),
        task: request.task,
        semantic_state: "requested",
        reachability: "unknown",
        first_idle_observed_at: null,
        last_observed_at: null,
        last_error: null,
        settlement_json: null,
        settled_at: null,
        notification_state: {},
        owner_session: provenance,
        visibility: "public",
        phase: "provision",
        intents: [],
        revision: 0,
      };
      this.db
        .prepare("INSERT INTO jobs VALUES(?,?,?,?,?,0,?)")
        .run(
          id,
          request.key,
          hash,
          request.machine_id,
          j.semantic_state,
          JSON.stringify(j),
        );
      return j;
    });
  }
  update(fence, job, changes, notification, maintenance = false) {
    return this.tx(() => {
      this.check(fence);
      const current = this.get(job.job_id);
      if (!current || current.revision !== job.revision)
        throw new Error("stale job revision");
      if (terminal(current) && !maintenance) throw new Error("job is terminal");
      if (
        maintenance &&
        Object.keys(changes).some(
          (k) =>
            !["cleanup_state", "cleanup_actor", "cleanup_error"].includes(k),
        )
      )
        throw new Error("invalid maintenance mutation");
      const next = {
        ...current,
        ...changes,
        updated_at: this.now(),
        revision: current.revision + 1,
      };
      this.db
        .prepare(
          "UPDATE jobs SET semantic_state=?,revision=?,data=? WHERE job_id=?",
        )
        .run(
          next.semantic_state,
          next.revision,
          JSON.stringify(next),
          job.job_id,
        );
      const retire = (pattern) =>
        this.db
          .prepare(
            "UPDATE notifications SET delivered=2 WHERE job_id=? AND id LIKE ? AND delivered IN (0,1)",
          )
          .run(job.job_id, pattern);
      if (terminal(next) && !maintenance) retire(`${job.job_id}-%`);
      else if (!maintenance) {
        if (
          next.observation !== "blocked" ||
          next.blocked_episode !== current.blocked_episode
        )
          retire(`${job.job_id}-blocked-%`);
        if (
          next.observation !== "idle" ||
          next.idle_episode !== current.idle_episode
        )
          retire(`${job.job_id}-idle-unsettled-%`);
        if (next.observation !== "gone") retire(`${job.job_id}-gone`);
      }
      if (notification)
        this.db
          .prepare(
            "INSERT OR IGNORE INTO notifications(id,job_id,body) VALUES(?,?,?)",
          )
          .run(notification.id, job.job_id, JSON.stringify(notification));
      return next;
    });
  }
  pending(fence) {
    this.check(fence);
    return this.db
      .prepare(
        "SELECT id,body,delivered FROM notifications WHERE delivered IN (0,2) LIMIT 64",
      )
      .all()
      .map((r) => ({ ...JSON.parse(r.body), withdraw: r.delivered === 2 }));
  }
  delivered(fence, id, withdrawn = false) {
    this.tx(() => {
      this.check(fence);
      this.db
        .prepare(
          "UPDATE notifications SET delivered=? WHERE id=? AND delivered=?",
        )
        .run(withdrawn ? 3 : 1, id, withdrawn ? 2 : 0);
    });
  }
  gc(fence, days = LIMITS.retentionDays) {
    return this.tx(() => {
      this.check(fence);
      let count = 0;
      for (const j of this.rows(
        "SELECT data,revision FROM jobs WHERE semantic_state IN ('settled','abandoned','failed_admission') AND json_extract(data,'$.cleanup_state')='complete' AND json_extract(data,'$.retained_tombstone') IS NULL AND json_extract(data,'$.updated_at') < ? LIMIT 128",
        this.now() - days * 86400000,
      )) {
        if (
          !terminal(j) ||
          j.cleanup_state !== "complete" ||
          j.updated_at > this.now() - days * 86400000 ||
          j.retained_tombstone
        )
          continue;
        if (
          this.db
            .prepare(
              "SELECT 1 FROM notifications WHERE job_id=? AND delivered IN (0,2)",
            )
            .get(j.job_id)
        )
          continue;
        // Admission identity + first-settlement fact survive forever; bounded
        // details/report data expire only after explicit remote cleanup.
        const next = {
          ...j,
          settlement_json: null,
          task: null,
          intents: [],
          last_error: null,
          operator: j.operator
            ? { actor: j.operator.actor, at: j.operator.at }
            : null,
          operation_resolution: j.operation_resolution
            ? {
                actor: j.operation_resolution.actor,
                at: j.operation_resolution.at,
                resolution: j.operation_resolution.resolution,
              }
            : null,
          machine_identity: Object.fromEntries(
            ["name", "session", "host_key", "port", "ssh_user"].map((k) => [
              k,
              j.machine_identity[k],
            ]),
          ),
          retained_tombstone: true,
        };
        this.db
          .prepare("UPDATE jobs SET data=? WHERE job_id=?")
          .run(JSON.stringify(next), j.job_id);
        this.db
          .prepare(
            "DELETE FROM notifications WHERE job_id=? AND delivered IN (1,3)",
          )
          .run(j.job_id);
        count++;
      }
      return count;
    });
  }
  close() {
    this.db.close();
  }
}
