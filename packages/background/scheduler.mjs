import { bounded, LIMITS } from "./protocol.mjs";
import { TERMINAL } from "./store.mjs";

/** Branch acceptance is synchronous and durable. Execution promises NEVER cross
 * this port into a foreground dispatch gate. Each runtime has its own lane;
 * slow abort/turn/retry on A cannot hold B or the foreground. The caller supplies
 * a session-local runtime, not a shared AgentSessionRuntime or loader.
 *
 * This is a host component, not an extension entrypoint. No globals, descriptor,
 * bearer, signal handlers, raw event bus, fork capability, or automatic discovery.
 */
export class BranchScheduler {
  constructor(
    store,
    {
      turnTimeoutMs = 15 * 60_000,
      abortTimeoutMs = 5000,
      idleTimeoutMs = 60 * 60_000,
      onError = () => {},
      onSettled = () => {},
    } = {},
  ) {
    for (const ms of [turnTimeoutMs, abortTimeoutMs, idleTimeoutMs])
      if (!Number.isFinite(ms) || ms <= 0)
        throw new Error("invalid lifecycle deadline");
    this.store = store;
    this.turnTimeoutMs = turnTimeoutMs;
    this.abortTimeoutMs = abortTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.onError = onError;
    this.onSettled = onSettled;
    this.live = new Map();
    this.closed = false;
  }
  register(key, generation, runtime) {
    const record = this.store.get(key);
    if (
      this.closed ||
      !record ||
      record.generation !== generation ||
      record.status !== "running" ||
      this.live.has(key) ||
      this.live.size >= LIMITS.active
    )
      throw new Error("cannot register runtime");
    // Reject identity/file aliasing even when wrapped in a different JS object.
    for (const item of this.live.values())
      if (
        item.runtime === runtime ||
        item.runtime.sessionId === runtime.sessionId ||
        item.runtime.file === runtime.file
      )
        throw new Error("session writer collision");
    if (
      runtime.sessionId !== record.archive.sessionId ||
      runtime.file !== record.archive.file
    )
      throw new Error("runtime archive identity mismatch");
    const lane = {
      generation,
      runtime,
      busy: false,
      retiring: false,
      idleTimer: null,
      task: null,
    };
    this.live.set(key, lane);
    this.armIdle(key, lane);
  }
  armIdle(key, lane) {
    clearTimeout(lane.idleTimer);
    lane.idleTimer = setTimeout(() => {
      if (!lane.retiring && !lane.busy) {
        try {
          this.cancel(key, lane.generation, "idle deadline");
        } catch (error) {
          this.onError(error);
        }
      }
    }, this.idleTimeoutMs);
    lane.idleTimer.unref?.();
  }
  start(key, generation) {
    const lane = this.lane(key, generation);
    if (lane.busy) throw new Error("branch busy");
    this.launch(key, lane, null);
    return { accepted: true };
  }
  steer(key, generation, commandId, content) {
    const lane = this.lane(key, generation);
    this.store.enqueue(key, generation, commandId, content);
    // Queue rather than awaiting prompt(). This preserves durable command order
    // and does not race prompt preflight. Runtime turn deadline bounds delivery.
    this.pump(key, lane);
    return { accepted: true, commandId };
  }
  lane(key, generation) {
    const lane = this.live.get(key);
    if (this.closed || !lane || lane.generation !== generation || lane.retiring)
      throw new Error("stale or unavailable branch");
    return lane;
  }
  pump(key, lane) {
    if (lane.busy || lane.retiring || this.closed) return;
    const command = this.store
      .get(key)
      ?.commands.find((c) => c.status === "queued");
    if (command) this.launch(key, lane, command);
  }
  launch(key, lane, command) {
    clearTimeout(lane.idleTimer);
    // The durable run intent precedes any provider or tool effect. A crash on
    // either side of runtime.run() is uncertain, never automatically replayed.
    const started = this.store.start(key, lane.generation);
    if (command)
      this.store.update(key, lane.generation, "command-start", (r) => {
        r.commands.find((c) => c.id === command.id).status = "executing";
      });
    lane.busy = true;
    const timer = setTimeout(() => {
      if (!lane.retiring) {
        try {
          this.cancel(key, lane.generation, "turn deadline");
        } catch (error) {
          this.onError(error);
        }
      }
    }, this.turnTimeoutMs);
    lane.turnTimer = timer;
    // Defer invocation as well as completion. Acceptance never executes a tool
    // factory or synchronous provider callback under a foreground gate.
    lane.task = new Promise((resolve) => setImmediate(resolve))
      .then(async () => {
        if (lane.retiring) return;
        await lane.runtime.run(command?.content);
        if (lane.retiring) return;
        // runtime.run's contract is full settlement incl. retries/queued work,
        // not agent_end. The Pi adapter must verify agent_settled independently.
        if (command)
          this.store.update(key, lane.generation, "command-done", (r) => {
            r.commands.find((c) => c.id === command.id).status = "done";
          });
        this.store.settle(key, lane.generation, started.run);
      })
      .catch((error) => {
        this.onError(error);
        if (!lane.retiring) {
          try {
            this.cancel(key, lane.generation, "branch execution failed");
          } catch (failure) {
            this.onError(failure);
          }
        }
      })
      .finally(() => {
        clearTimeout(timer);
        lane.busy = false;
        if (!lane.retiring) {
          this.armIdle(key, lane);
          this.pump(key, lane);
          if (!lane.busy) {
            try { this.onSettled(key, lane.generation); } catch (error) { this.onError(error); }
          }
        }
      });
  }
  cancel(key, generation, reason) {
    const lane = this.lane(key, generation);
    bounded(reason, 1024, "cancellation reason");
    const record = this.store.cancel(key, generation);
    lane.retiring = true;
    clearTimeout(lane.idleTimer);
    lane.retirement = this.retire(key, record.generation, lane);
    return { accepted: true, generation: record.generation };
  }
  async retire(key, generation, lane) {
    let timer;
    clearTimeout(lane.turnTimer);
    try {
      // Abort includes child cancellation/settlement in the adapter contract.
      const done = await Promise.race([
        Promise.all([
          Promise.resolve().then(() => lane.runtime.abort()),
          lane.task,
        ]).then(() => { lane.stopped = true; return true; }),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), this.abortTimeoutMs);
        }),
      ]);
      const record = this.store.get(key);
      if (!record || record.generation !== generation) return;
      if (!TERMINAL.has(record.status) && record.status !== "rejoining")
        this.store.update(key, generation, "retire", (r) => {
          r.status = done ? "cancelled" : "orphaned";
          if (!done)
            r.failure =
              "Abort deadline elapsed; live writer/child outcome uncertain";
        });
      // Never dispose a still-running writer or free capacity on uncertainty.
      // It stays quarantined in live until process death or explicit recovery.
      if (done) {
        lane.runtime.dispose();
        this.live.delete(key);
      }
    } catch (error) {
      this.onError(error);
      this.store.update(key, generation, "retire-error", (r) => {
        r.status = "orphaned";
        r.failure = "Abort failed; writer outcome uncertain";
      });
    } finally {
      clearTimeout(timer);
    }
  }
  releaseQuarantine(key, generation) {
    const record = this.store.get(key);
    const lane = this.live.get(key);
    if (!record || record.generation !== generation || record.status !== "orphaned" || !lane?.stopped)
      throw new Error("writer retirement not proven");
    this.store.update(key, generation, "quarantine-release", (r) => { r.status = "cancelled"; });
    lane.runtime.dispose();
    this.live.delete(key);
  }
  async shutdown() {
    if (!this.closed) {
      // Rejoin is a cross-archive transaction: preserve its delivery intent for
      // reconciliation rather than overwrite it with a cancellation receipt.
      this.closed = true;
      for (const [key, lane] of this.live) {
        clearTimeout(lane.idleTimer);
        if (lane.retiring) continue;
        lane.retiring = true;
        const record = this.store.get(key);
        if (!record) continue;
        let generation = record.generation;
        if (
          !TERMINAL.has(record.status) &&
          record.status !== "rejoining" &&
          record.status !== "cancelling"
        )
          generation = this.store.cancel(key, generation).generation;
        lane.retirement = this.retire(key, generation, lane);
      }
    }
    await Promise.all([...this.live.values()].map((lane) => lane.retirement));
    return { quarantined: [...this.live.keys()] };
  }
}
