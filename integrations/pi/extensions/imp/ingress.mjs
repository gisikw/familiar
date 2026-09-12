import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

export const IMP_ENV = "FAMILIAR_IMP_SOCKET";
export const IMP_WIRE_LIMIT = 1 << 20;
export const IMP_PLATE_HANDLER = Symbol.for("familiar.imp.plate.v1");
export const IMP_AGENT_HANDLER = Symbol.for("familiar.imp.agent.v1");
const IMP_INGRESS_OWNER = Symbol.for("familiar.imp.ingress.v1");
const CONNECTION_LIMIT = 16;
const CONNECTION_TIMEOUT_MS = 5000;

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function requestRecord(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    throw Object.assign(new Error("invalid JSON request"), { code: "invalid_request" });
  }
  if (
    !plainObject(request) ||
    Object.keys(request).some(
      (key) => !["version", "area", "operation", "args"].includes(key),
    ) ||
    request.version !== 1 ||
    !["plate", "agent"].includes(request.area) ||
    typeof request.operation !== "string" ||
    !request.operation ||
    !plainObject(request.args)
  )
    throw Object.assign(new Error("invalid Imp request envelope or area"), {
      code: "invalid_request",
    });
  return request;
}
function errorMessage(error) {
  const value = error instanceof Error ? error.message : "operation failed";
  return Buffer.from(value).subarray(0, 4096).toString("utf8") || "operation failed";
}

/** The sole temporary Imp transport. This is deliberately a fixed two-area
 * switch, not a registry or externally discoverable endpoint. */
export class ImpIngress {
  constructor() {
    this.connections = new Set();
  }
  async start() {
    if (this.server || process[IMP_INGRESS_OWNER])
      throw new Error("Imp ingress already started");
    process[IMP_INGRESS_OWNER] = this;
    this.directory = mkdtempSync(join(tmpdir(), "familiar-imp-"));
    chmodSync(this.directory, 0o700);
    this.path = join(this.directory, "resident.sock");
    this.server = createServer((socket) => this.accept(socket));
    this.server.maxConnections = CONNECTION_LIMIT;
    await new Promise((resolve, reject) => {
      const failed = (error) => reject(error);
      this.server.once("error", failed);
      this.server.listen(this.path, () => {
        this.server.off("error", failed);
        resolve();
      });
    });
    chmodSync(this.path, 0o600);
    this.server.on("error", () => {});
    process.env[IMP_ENV] = this.path;
    return this.path;
  }
  handler(area) {
    const key = area === "plate" ? IMP_PLATE_HANDLER : IMP_AGENT_HANDLER;
    const value = process[key];
    if (!value || typeof value.handle !== "function")
      throw Object.assign(
        new Error(`${area} unavailable in this owning Familiar resident`),
        { code: "unavailable" },
      );
    return value;
  }
  accept(socket) {
    if (this.stopping || this.connections.size >= CONNECTION_LIMIT) {
      socket.destroy();
      return;
    }
    this.connections.add(socket);
    socket.setTimeout(CONNECTION_TIMEOUT_MS, () => socket.destroy());
    let chunks = [];
    let bytes = 0;
    let processing = false;
    const finish = (envelope) => {
      if (socket.destroyed) return;
      let body = Buffer.from(JSON.stringify(envelope) + "\n");
      if (body.length > IMP_WIRE_LIMIT)
        body = Buffer.from(
          JSON.stringify({
            ok: false,
            error: {
              code: "result_too_large",
              message: "Imp result exceeds wire limit",
            },
          }) + "\n",
        );
      socket.end(body);
    };
    socket.on("data", (chunk) => {
      if (processing) return socket.destroy();
      bytes += chunk.length;
      if (bytes > IMP_WIRE_LIMIT) return socket.destroy();
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      const newline = all.indexOf(10);
      if (newline < 0) return;
      if (newline !== all.length - 1) return socket.destroy();
      processing = true;
      Promise.resolve()
        .then(() => requestRecord(all.subarray(0, newline).toString("utf8")))
        .then((request) => this.handler(request.area).handle(request))
        .then((result) => finish({ ok: true, result }))
        .catch((error) =>
          finish({
            ok: false,
            error: {
              code: ["invalid_request", "unavailable"].includes(error?.code)
                ? error.code
                : "operation_failed",
              message: errorMessage(error),
            },
          }),
        );
    });
    socket.on("end", () => {
      if (!processing && bytes) socket.destroy();
    });
    socket.on("close", () => this.connections.delete(socket));
    socket.on("error", () => {});
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (process.env[IMP_ENV] === this.path) delete process.env[IMP_ENV];
      if (process[IMP_INGRESS_OWNER] === this) delete process[IMP_INGRESS_OWNER];
      for (const socket of this.connections) socket.destroy();
      if (this.server)
        await new Promise((resolve) => this.server.close(() => resolve()));
      if (this.directory)
        rmSync(this.directory, { recursive: true, force: true });
    })();
    return this.stopping;
  }
}
