import type http from "node:http";
import type { Channel } from "./channels.ts";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** POST /merge is meaningful only for a fork: content remains entirely the
 * fork's decision, while the operator may choose quiet parent delivery. */
export async function handleMerge(req: http.IncomingMessage, res: http.ServerResponse, channel: Channel) {
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
  if (channel.role !== "fork" || !channel.parentSessionId) {
    res.statusCode = 409;
    return res.end("session has no parent");
  }

  const raw = await readBody(req);
  let payload: unknown = {};
  try { if (raw.trim()) payload = JSON.parse(raw); }
  catch { res.statusCode = 400; return res.end(); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || Object.keys(payload).some((key) => key !== "quiet")
    || ("quiet" in payload && typeof (payload as { quiet?: unknown }).quiet !== "boolean")) {
    res.statusCode = 400;
    return res.end();
  }

  const quiet = (payload as { quiet?: boolean }).quiet;
  channel.relay.send({ type: "merge", ...(quiet === undefined ? {} : { quiet }) });
  res.statusCode = 204;
  res.end();
}
