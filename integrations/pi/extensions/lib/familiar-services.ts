import { createConnection } from "node:net";

export const DEFAULT_FAMILIAR_SERVICES_SOCKET = "/run/familiar-services/familiar.sock";
export const familiarServicesSocket = () => process.env.FAMILIAR_SERVICES_SOCKET || DEFAULT_FAMILIAR_SERVICES_SOCKET;

export interface ServiceError { code: string; message: string }
type Response<T> = { ok: true; result: T } | { ok: false; error: ServiceError };

/** One request per connection keeps lifecycle and reconnect handling trivial. */
export function serviceCall<T>(op: string, args: Record<string, unknown> = {}, socketPath = familiarServicesSocket()): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const detail = error instanceof Error ? error.message : String(error);
      reject(new Error(`familiar-services unavailable at ${socketPath}: ${detail}`, { cause: error }));
    };
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => fail(new Error("request timed out")));
    socket.on("error", fail);
    socket.on("connect", () => socket.write(`${JSON.stringify({ op, args })}\n`));
    socket.on("data", (chunk) => {
      data += chunk;
      const newline = data.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(data) > 1024 * 1024) fail(new Error("response exceeds 1 MiB"));
        return;
      }
      if (settled) return;
      settled = true;
      socket.end();
      let response: Response<T>;
      try { response = JSON.parse(data.slice(0, newline)) as Response<T>; }
      catch (error) { return reject(new Error(`invalid familiar-services response from ${socketPath}`, { cause: error })); }
      if (response.ok) resolve(response.result);
      else {
        const error = Object.assign(new Error(`familiar-services ${op}: ${response.error.message}`), { code: response.error.code });
        reject(error);
      }
    });
    socket.on("end", () => { if (!settled) fail(new Error("connection closed before a response")); });
  });
}
