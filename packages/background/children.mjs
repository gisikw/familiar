import { createHash } from "node:crypto";
import { bounded, id, LIMITS } from "./protocol.mjs";

const terminal = new Set(["done", "failed", "cancelled", "timeout"]);
const writable = new Set(["running"]);

/** Ownership adapter around the existing GolemClient API. It does not create a
 * job lifecycle, retry protocol, or settlement engine. golemd remains truth for
 * those. Durable create keys bridge dispatch-before-receipt; only this binding's
 * children are addressable. There is no global worklist or foreground fallback.
 */
export class OwnedChildren {
  constructor(store, key, generation, client) {
    this.store = store;
    this.key = key;
    this.generation = generation;
    this.client = client;
  }
  record() {
    const r = this.store.get(this.key);
    if (!r || r.generation !== this.generation || !writable.has(r.status))
      throw new Error("stale child owner");
    return r;
  }
  owned(jobId) {
    const child = this.record().children.find((c) => c.jobId === id(jobId));
    if (!child) throw new Error("child not owned by workstream");
    return child;
  }
  async dispatch(key, request) {
    id(key);
    bounded(request, LIMITS.commandBytes, "child dispatch");
    const digest = createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    const createKey = `background:${this.key}:${key}`;
    this.store.update(this.key, this.generation, "child-intent", (r) => {
      this.record();
      const prior = r.children.find((c) => c.key === key);
      if (prior) {
        if (prior.digest !== digest)
          throw new Error("child dispatch replay conflict");
        return;
      }
      if (r.children.length >= LIMITS.children)
        throw new Error("child quota reached");
      r.children.push({
        key,
        digest,
        createKey,
        request,
        jobId: null,
        terminal: false,
        questionId: null,
        eventSeq: 0,
      });
      r.settledRun = null;
    });
    // Stable request key is persisted BEFORE the network. A timeout is uncertain:
    // retry this SAME key through golemd, never generate another worker identity.
    const job = await this.client.dispatch({
      ...request,
      idempotency_key: createKey,
    });
    id(job.id);
    try {
      this.store.update(this.key, this.generation, "child-receipt", (r) => {
        this.record();
        for (const other of this.store.list())
          if (
            other.children.some(
              (c) =>
                c.jobId === job.id && (other.id !== this.key || c.key !== key),
            )
          )
            throw new Error("child owner collision");
        const child = r.children.find((c) => c.key === key);
        if (child.jobId && child.jobId !== job.id)
          throw new Error("golemd create identity changed");
        child.jobId = job.id;
        child.terminal = terminal.has(job.state) && Boolean(job.settlement);
        child.questionId =
          job.state === "blocked" && job.question && !job.question.answer
            ? id(job.question.id)
            : null;
        if ((child.terminal || child.questionId) && !child.pendingEvent)
          child.pendingEvent = { seq: child.eventSeq, job };
      });
    } catch (error) {
      // Cancellation/replacement may win while create is in flight. Cancel that
      // exact returned job; do not register it under a different/new generation.
      const owner = this.store.get(this.key);
      if (
        !owner ||
        owner.generation !== this.generation ||
        !writable.has(owner.status)
      )
        await this.client.cancel(job.id);
      throw error;
    }
    return job;
  }
  async observe(event) {
    const r = this.record();
    const child = r.children.find((c) => c.jobId === event.job_id);
    if (!child) return false; // not ours: never deliver to foreground here
    if (!Number.isSafeInteger(event.seq) || event.seq <= 0)
      throw new Error("invalid event sequence");
    bounded(event, LIMITS.commandBytes, "child event");
    if (event.seq <= child.eventSeq) return false;
    // SSE is an invalidation hint: it does not carry the blocked question or
    // complete settlement. Fetch authoritative detail through the existing API.
    const job = await this.client.status(event.job_id);
    if (job.id !== event.job_id)
      throw new Error("child status identity mismatch");
    bounded(job, LIMITS.commandBytes, "child status");
    this.record();
    let accepted = false;
    this.store.update(this.key, this.generation, "child-event", (record) => {
      const current = record.children.find((c) => c.jobId === event.job_id);
      if (event.seq <= current.eventSeq) return;
      accepted = true;
      current.eventSeq = event.seq;
      // Persist compact latest status, not an unbounded event/transcript list.
      current.pendingEvent = { seq: event.seq, job };
      current.terminal = terminal.has(job.state) && Boolean(job.settlement);
      current.questionId =
        job.state === "blocked" && job.question && !job.question.answer
          ? id(job.question.id)
          : null;
      record.settledRun = null;
    });
    return accepted;
  }
  acknowledgeEvent(jobId, seq) {
    this.owned(jobId);
    return this.store.update(
      this.key,
      this.generation,
      "child-event-ack",
      (r) => {
        const child = r.children.find((c) => c.jobId === jobId);
        if (child.pendingEvent?.seq !== seq)
          throw new Error("stale child event acknowledgement");
        child.pendingEvent = null;
      },
    );
  }
  async status(jobId) {
    this.owned(jobId);
    return this.client.status(jobId);
  }
  async answer(jobId, questionId, key, text) {
    const child = this.owned(jobId);
    id(questionId);
    id(key);
    bounded(text, LIMITS.commandBytes, "child answer");
    if (child.questionId !== questionId)
      throw new Error("stale child question");
    const result = await this.client.answer(jobId, {
      question_id: questionId,
      idempotency_key: `${this.key}:${key}`,
      text,
    });
    this.store.update(this.key, this.generation, "child-answer", (r) => {
      const current = r.children.find((c) => c.jobId === jobId);
      if (current.questionId === questionId) current.questionId = null;
    });
    return result;
  }
  async cancel(jobId) {
    this.owned(jobId);
    return this.client.cancel(jobId);
  }
  async artifacts(jobId) {
    this.owned(jobId);
    return this.client.artifacts(jobId);
  }
  async fetchArtifact(jobId, path) {
    this.owned(jobId);
    return this.client.fetchArtifact(jobId, path);
  }
}
