/** One subscription per host; backend events are invalidations, never foreground
 * messages. O(1) foreign-event rejection and one coalesced event per owned job.
 * Failed detail reads remain queued independently of the reconnect cursor.
 */
export class ChildSubscription {
  constructor(
    store,
    scheduler,
    backend,
    { onChange = () => {}, retryMs = 250 } = {},
  ) {
    this.store = store;
    this.scheduler = scheduler;
    this.backend = backend;
    this.onChange = onChange;
    this.retryMs = retryMs;
    this.pending = new Map();
    this.cursor = 0;
    this.controller = new AbortController();
    this.draining = null;
    this.retry = null;
  }
  accept(event) {
    if (
      this.controller.signal.aborted ||
      !Number.isSafeInteger(event.seq) ||
      event.seq <= 0
    )
      return;
    this.cursor = Math.max(this.cursor, event.seq);
    const owner = this.store.childOwner(event.job_id);
    if (!owner || owner.status !== "running") return;
    const prior = this.pending.get(event.job_id);
    if (!prior || prior.seq < event.seq)
      this.pending.set(event.job_id, { job_id: event.job_id, seq: event.seq });
    void this.drain();
  }
  async drain() {
    if (this.draining || this.controller.signal.aborted) return;
    this.draining = (async () => {
      for (const [jobId, event] of this.pending) {
        if (this.controller.signal.aborted) return;
        const owner = this.store.childOwner(jobId);
        const lane = owner && this.scheduler.live.get(owner.id);
        if (!lane || lane.retiring || lane.generation !== owner.generation) {
          this.pending.delete(jobId);
          continue;
        }
        try {
          const changed = await lane.runtime.children.observe(event);
          if (this.controller.signal.aborted) return;
          if (changed || lane.runtime.children.owned(jobId).pendingEvent) {
            this.scheduler.wakeChildren(owner.id, owner.generation);
            this.onChange();
          }
          if (this.pending.get(jobId) === event) this.pending.delete(jobId);
        } catch {
          /* retain latest invalidation; no foreground fallback */
        }
      }
    })();
    try {
      await this.draining;
    } finally {
      this.draining = null;
      if (this.pending.size && !this.controller.signal.aborted) {
        clearTimeout(this.retry);
        this.retry = setTimeout(() => void this.drain(), this.retryMs);
        this.retry.unref?.();
      }
    }
  }
  start() {
    this.task = (async () => {
      while (!this.controller.signal.aborted) {
        try {
          await this.backend.streamEvents(
            this.cursor,
            (event) => this.accept(event),
            this.controller.signal,
          );
        } catch {
          /* reconnect */
        }
        if (!this.controller.signal.aborted)
          await new Promise((resolve) => {
            const done = () => {
              clearTimeout(timer);
              this.controller.signal.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, this.retryMs);
            this.controller.signal.addEventListener("abort", done, {
              once: true,
            });
          });
      }
    })();
  }
  async stop() {
    this.controller.abort();
    clearTimeout(this.retry);
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([this.task, this.draining]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.pending.clear();
    }
  }
}
