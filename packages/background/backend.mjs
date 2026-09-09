import { bounded, LIMITS } from "./protocol.mjs";

export const CHILD_RETENTION_DAYS = 14;

/** Backend-owned storage policy, not an invented filesystem quota. A future
 * Familiar Agents ledger implements this same normalized job/settlement port.
 * No worktree/artifact deletion API is exposed to Background.
 */
export class ChildBackend {
  constructor(
    transport,
    { softBytes = null, retentionDays = CHILD_RETENTION_DAYS } = {},
  ) {
    if (
      (softBytes !== null &&
        (!Number.isSafeInteger(softBytes) || softBytes <= 0)) ||
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 30
    )
      throw new Error("invalid child backend policy");
    this.transport = transport;
    this.softBytes = softBytes;
    this.retentionDays = retentionDays;
    this.resources = {
      admission: "unknown",
      usageBytes: null,
      softLimitBytes: softBytes,
      hardQuota: false,
      retentionDays,
    };
  }
  resourceStatus() {
    return { ...this.resources };
  }
  async capabilities() {
    try {
      const capabilities = await this.transport.capabilities();
      bounded(capabilities, LIMITS.commandBytes, "backend capabilities");
      const reported = capabilities.resources;
      let usageBytes = null,
        softLimitBytes = this.softBytes,
        hardQuota = false,
        admission = "unknown";
      if (reported !== undefined) {
        if (!reported || typeof reported !== "object")
          throw new Error("invalid backend resource status");
        for (const field of ["usageBytes", "softLimitBytes"])
          if (
            reported[field] !== undefined &&
            reported[field] !== null &&
            (!Number.isSafeInteger(reported[field]) || reported[field] < 0)
          )
            throw new Error("invalid backend resource accounting");
        if (
          reported.admission !== undefined &&
          !["available", "blocked", "unknown"].includes(reported.admission)
        )
          throw new Error("invalid backend admission status");
        usageBytes = reported.usageBytes ?? null;
        if (reported.softLimitBytes != null)
          softLimitBytes =
            softLimitBytes === null
              ? reported.softLimitBytes
              : Math.min(softLimitBytes, reported.softLimitBytes);
        hardQuota = reported.hardQuota === true;
        admission = reported.admission ?? "unknown";
        if (
          reported.highWater === true ||
          (usageBytes !== null &&
            softLimitBytes !== null &&
            usageBytes >= softLimitBytes)
        )
          admission = "blocked";
      }
      this.resources = {
        admission,
        usageBytes,
        softLimitBytes,
        hardQuota,
        retentionDays: this.retentionDays,
      };
      return capabilities;
    } catch (error) {
      this.resources = { ...this.resources, admission: "blocked" };
      throw error;
    }
  }
  async checkAdmission() {
    await this.capabilities();
    if (this.resources.admission === "blocked")
      throw new Error("child backend cannot admit another job");
  }
  async dispatch(request) {
    await this.checkAdmission();
    // The backend decides final admission. Failure/uncertainty never triggers a
    // different create key, an alternate backend, or foreground execution.
    try {
      return await this.transport.dispatch({
        ...request,
        artifacts: { retention_days: this.retentionDays },
      });
    } catch (error) {
      this.resources = { ...this.resources, admission: "blocked" };
      throw error;
    }
  }
  async lookupCreate(key) {
    return this.transport.lookupCreate
      ? await this.transport.lookupCreate(key)
      : null;
  }
  status(id) {
    return this.transport.status(id);
  }
  answer(id, request) {
    return this.transport.answer(id, request);
  }
  steer(id, text) {
    return this.transport.steer(id, text);
  }
  cancel(id) {
    return this.transport.cancel(id);
  }
  artifacts(id) {
    return this.transport.artifacts(id);
  }
  fetchArtifact(id, path) {
    return this.transport.fetchArtifact(id, path);
  }
  streamEvents(since, onEvent, signal) {
    return this.transport.streamEvents(since, onEvent, signal);
  }
}
