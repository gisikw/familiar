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
    if (
      this.client.checkAdmission &&
      !this.record().children.some((child) => child.key === key)
    )
      await this.client.checkAdmission();
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
      if (
        this.store
          .list()
          .flatMap((owner) => owner.children)
          .filter((child) => !child.terminal).length >= LIMITS.activeChildren
      )
        throw new Error("active child reservation quota reached");
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
    const existing = this.record().children.find((child) => child.key === key);
    const job = existing.jobId
      ? await this.client.status(existing.jobId)
      : await this.client.dispatch({
          ...request,
          idempotency_key: createKey,
        });
    bounded(job, LIMITS.commandBytes, "child dispatch receipt");
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
        child.lastState = job.state;
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
    // A terminal/question event may have raced ahead of the create receipt,
    // while its job id was not yet indexed. Reconcile after linking ownership.
    return this.client.status ? await this.status(job.id) : job;
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
    if (child.cancellationRequested && !terminal.has(job.state))
      await this.client.cancel(event.job_id);
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
      current.lastState = job.state;
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
    const before = this.owned(jobId).eventSeq;
    const job = await this.client.status(jobId);
    bounded(job, LIMITS.commandBytes, "child status");
    if (job.id !== jobId) throw new Error("child status identity mismatch");
    const current = this.owned(jobId);
    if (current.eventSeq !== before) return current.pendingEvent?.job ?? job;
    const isTerminal = terminal.has(job.state) && Boolean(job.settlement);
    const questionId =
      job.state === "blocked" && job.question && !job.question.answer
        ? id(job.question.id)
        : null;
    if (
      current.lastState !== job.state ||
      current.terminal !== isTerminal ||
      current.questionId !== questionId
    )
      this.store.update(this.key, this.generation, "child-refresh", (r) => {
        const child = r.children.find((c) => c.jobId === jobId);
        child.lastState = job.state;
        child.terminal = isTerminal;
        child.questionId = questionId;
        child.pendingEvent = { seq: before, job };
        r.settledRun = null;
      });
    return job;
  }
  async answer(jobId, questionId, key, text) {
    const child = this.owned(jobId);
    id(questionId);
    id(key);
    bounded(text, LIMITS.commandBytes, "child answer");
    if (typeof text !== "string" || !text.trim())
      throw new Error("empty child answer");
    if (child.questionId !== questionId)
      throw new Error("stale child question");
    this.store.update(this.key, this.generation, "child-answer-intent", (r) => {
      const current = r.children.find((c) => c.jobId === jobId);
      const intent = { questionId, key, text };
      if (
        current.pendingAnswer &&
        JSON.stringify(current.pendingAnswer) !== JSON.stringify(intent)
      )
        throw new Error("answer replay conflict");
      current.pendingAnswer = intent;
    });
    const result = await this.client.answer(jobId, {
      question_id: questionId,
      idempotency_key: `${this.key}:${key}`,
      text,
    });
    this.store.update(this.key, this.generation, "child-answer", (r) => {
      const current = r.children.find((c) => c.jobId === jobId);
      if (current.questionId === questionId) current.questionId = null;
      current.pendingAnswer = null;
    });
    return result;
  }
  async steer(jobId, key, text) {
    const child = this.owned(jobId);
    id(key);
    bounded(text, LIMITS.commandBytes, "child steering");
    if (typeof text !== "string" || !text.trim() || child.terminal)
      throw new Error("child cannot be steered");
    const digest = createHash("sha256")
      .update(JSON.stringify({ jobId, text }))
      .digest("hex");
    const prior = this.record().childSteerKeys?.find(
      (entry) => entry.key === key,
    );
    if (prior && prior.digest !== digest)
      throw new Error("steer replay conflict");
    if (prior && prior.status !== "delivered")
      throw new Error(
        "steer outcome uncertain; inspect backend, do not replay",
      );
    if (prior && child.lastSteer?.key !== key)
      return { previouslyDelivered: true };
    if (child.lastSteer?.key === key) {
      if (child.lastSteer.text !== text)
        throw new Error("steer replay conflict");
      if (child.lastSteer.status !== "delivered")
        throw new Error(
          "steer outcome uncertain; inspect backend, do not replay",
        );
      return child.lastSteer.receipt;
    }
    if (child.lastSteer?.status === "uncertain")
      throw new Error("prior steer outcome uncertain; inspect backend");
    this.store.update(this.key, this.generation, "child-steer-intent", (r) => {
      r.childSteerKeys ??= [];
      if (r.childSteerKeys.length >= LIMITS.commands)
        throw new Error("child steer quota reached");
      r.childSteerKeys.push({ key, digest, status: "uncertain" });
      r.children.find((c) => c.jobId === jobId).lastSteer = {
        key,
        text,
        status: "uncertain",
      };
    });
    const receipt = await this.client.steer(jobId, text);
    bounded(receipt, LIMITS.commandBytes, "child steer receipt");
    this.store.update(this.key, this.generation, "child-steer-receipt", (r) => {
      const current = r.children.find((c) => c.jobId === jobId);
      current.lastSteer = { key, text, status: "delivered", receipt };
      r.childSteerKeys.find((entry) => entry.key === key).status = "delivered";
    });
    return receipt;
  }
  async cancel(jobId) {
    this.owned(jobId);
    this.store.update(this.key, this.generation, "child-cancel-intent", (r) => {
      r.children.find((c) => c.jobId === jobId).cancellationRequested = true;
    });
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
