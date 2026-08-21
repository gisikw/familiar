import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawn } from "child_process";
import { debugLog, errorLog } from "./debug.ts";

/* --- POST /upload: drag-and-drop file capture ------------------------------
 *
 * Kevin drags a file (a screenshot, usually) onto the browser terminal or the
 * Electron client; the bytes land here, get written to a drops directory on
 * the server host, and the path is sent through the existing pi relay ingress.
 * Two intake shapes are accepted:
 *
 *   (a) raw body   — filename from ?name= or an X-Filename header. Simplest for
 *                    programmatic clients (Electron: one fetch, no FormData).
 *   (b) multipart  — the browser's natural FormData path.
 *
 * No auth (localhost + nginx upstream). Permissive CORS because the Electron
 * client posts with an Origin of file:// / app://.
 */

const CAP = Number(process.env.FAMILIAR_UPLOAD_MAX_BYTES ?? 50 * 1024 * 1024);

function dropsDir(): string {
  if (process.env.FAMILIAR_DROPS_DIR) return path.resolve(process.env.FAMILIAR_DROPS_DIR);
  if (process.env.FAMILIAR_LOG_PATH) return path.join(path.dirname(path.resolve(process.env.FAMILIAR_LOG_PATH)), "uploads");
  const uid = process.getuid?.();
  return path.join(os.tmpdir(), `familiar-drops-${uid ?? "user"}`);
}

function secureDropsDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }

  let info = fs.lstatSync(dir);
  if (info.isSymbolicLink()) throw new Error(`drops directory must not be a symlink: ${dir}`);
  if (!info.isDirectory()) throw new Error(`drops path must be a directory: ${dir}`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new Error(`drops directory is not owned by the gateway user: ${dir}`);

  fs.chmodSync(dir, 0o700);
  info = fs.lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o777) !== 0o700) {
    throw new Error(`drops directory failed security verification: ${dir}`);
  }
}

export function storeDroppedFile(data: Buffer, rawName?: string, directory = dropsDir()): string {
  const dir = path.resolve(directory);
  secureDropsDir(dir);
  const filename = sanitizeName(rawName);
  const dest = path.join(dir, filename);
  const temp = path.join(dir, `.${filename}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    secureDropsDir(dir);
    fs.renameSync(temp, dest);
    return dest;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { }
    throw error;
  }
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Filename",
  "Access-Control-Max-Age": "86400",
};

function sendJson(res: http.ServerResponse, code: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(code, { ...CORS, "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

/* Strip any path components, keep a conservative charset, prefix a timestamp so
 * repeated drops of the same name never collide. */
function sanitizeName(raw: string | undefined): string {
  let base = path.basename(String(raw ?? "").trim() || "drop");
  base = base.replace(/[^A-Za-z0-9._-]/g, "_");
  base = base.replace(/^\.+/, ""); // no leading dots -> no dotfiles / traversal
  if (!base) base = "drop";
  if (base.length > 128) base = base.slice(-128);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}__${base}`;
}

/* Collect the request body into a single Buffer, enforcing the cap while
 * streaming so an oversized upload is rejected without buffering it all. */
function readBodyCapped(req: http.IncomingMessage): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      if (aborted) return;
      total += c.length;
      if (total > CAP) {
        aborted = true;
        resolve("too-large");
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on("error", (e) => { if (!aborted) reject(e); });
  });
}

/* Minimal multipart/form-data parser — first file part only. node built-ins
 * only (no busboy). Returns null if no file part is present. */
function parseMultipart(buf: Buffer, contentType: string): { filename?: string; data: Buffer } | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const boundary = `--${m[1] ?? m[2]}`;
  const delim = Buffer.from(boundary);
  const parts: Buffer[] = [];
  let start = buf.indexOf(delim);
  if (start === -1) return null;
  start += delim.length;
  while (start < buf.length) {
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    // Skip the CRLF after the boundary; content runs to CRLF before next.
    let s = start;
    if (buf[s] === 0x0d && buf[s + 1] === 0x0a) s += 2;
    let e = next;
    if (buf[e - 2] === 0x0d && buf[e - 1] === 0x0a) e -= 2;
    if (e > s) parts.push(buf.subarray(s, e));
    start = next + delim.length;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const header = part.subarray(0, headerEnd).toString("utf8");
    const cd = /content-disposition:[^\r\n]*/i.exec(header)?.[0] ?? "";
    if (!/name=/i.test(cd)) continue;
    const fn = /filename\*?=(?:"([^"]*)"|([^;\r\n]*))/i.exec(cd);
    const filename = fn ? (fn[1] ?? fn[2]) : undefined;
    if (filename === undefined) continue; // a plain field, not a file
    const data = part.subarray(headerEnd + 4);
    return { filename, data };
  }
  return null;
}

/* --- Presence compatibility ingress -------------------------------------- */

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = "", err = "";
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: -1, out: "", err: String(e) });
    }
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: -1, out, err: err + String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

/* Resolve which agent/pane to notify. Explicit config wins; otherwise fall
 * back to the sole agent if exactly one exists. Returns null when ambiguous. */
async function resolveTarget(env: NodeJS.ProcessEnv): Promise<{ target: string } | { error: string }> {
  const configured = process.env.FAMILIAR_UPLOAD_NOTIFY_TARGET;
  if (configured) return { target: configured };
  const r = await run("herdr", ["agent", "list"], env);
  if (r.code !== 0) return { error: `herdr agent list failed: ${r.err || r.out || r.code}` };
  let agents: Array<{ pane_id?: string; name?: string; agent?: string }> = [];
  try {
    agents = JSON.parse(r.out)?.result?.agents ?? [];
  } catch (e) {
    return { error: `herdr agent list unparseable: ${String(e)}` };
  }
  if (agents.length === 1) {
    const a = agents[0];
    const target = a.pane_id || a.name || a.agent;
    if (target) return { target };
  }
  if (agents.length === 0) return { error: "no herdr agents to notify" };
  return { error: `ambiguous notify target (${agents.length} agents); set FAMILIAR_UPLOAD_NOTIFY_TARGET` };
}

/* Deliver the drop message to the agent. Uses `herdr agent prompt`, the
 * documented mechanism for submitting text to an agent so pi actually receives
 * (and can act on) it. The whole herdr env is kept (unlike the PTY attach) so
 * the CLI targets the current session. A test override — FAMILIAR_UPLOAD_NOTIFY_CMD
 * — replaces the CLI with an arbitrary shell command (drop path/message exposed
 * as env vars) so smoke tests never poke a live agent. */
export async function notifyDroppedFile(filePath: string, relayNotify?: (message: string) => boolean): Promise<{ notified: boolean; error?: string }> {
  const message = `[file dropped: ${filePath}]`;
  const env = { ...process.env }; // KEEP HERDR_* — this call must target the session.

  const override = process.env.FAMILIAR_UPLOAD_NOTIFY_CMD;
  if (override) {
    const r = await run("sh", ["-c", override], {
      ...env,
      FAMILIAR_DROP_PATH: filePath,
      FAMILIAR_DROP_MESSAGE: message,
    });
    if (r.code === 0) return { notified: true };
    return { notified: false, error: `notify cmd exit ${r.code}: ${r.err || r.out}`.trim() };
  }

  if (relayNotify) {
    if (relayNotify(message)) return { notified: true };
    return { notified: false, error: "presence relay has no connected pi subscriber" };
  }

  // Bounded legacy fallback for standalone embedding without a relay callback.
  const resolved = await resolveTarget(env);
  if ("error" in resolved) return { notified: false, error: resolved.error };

  const r = await run("herdr", ["agent", "prompt", resolved.target, message], env);
  // herdr's CLI can exit 0 while reporting a JSON {error:...}; treat that as failure.
  if (r.code === 0 && !/"error"\s*:/.test(r.out)) return { notified: true };
  return { notified: false, error: (r.err || r.out || `exit ${r.code}`).trim() };
}

/* --- entry point ---------------------------------------------------------- */

export async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse, searchParams: URLSearchParams, relayNotify?: (message: string) => boolean) {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== "POST") { res.writeHead(405, CORS); return res.end(); }

  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared && declared > CAP) return sendJson(res, 413, { ok: false, error: `too large (max ${CAP} bytes)` });

  let body: Buffer | "too-large";
  try {
    body = await readBodyCapped(req);
  } catch (e) {
    errorLog("subscriber", { uploadReadError: String(e) });
    return sendJson(res, 400, { ok: false, error: "read failed" });
  }
  if (body === "too-large") return sendJson(res, 413, { ok: false, error: `too large (max ${CAP} bytes)` });

  const contentType = String(req.headers["content-type"] ?? "");
  let rawName: string | undefined;
  let data: Buffer;

  if (contentType.startsWith("multipart/form-data")) {
    const parsed = parseMultipart(body, contentType);
    if (!parsed) return sendJson(res, 400, { ok: false, error: "no file part in multipart body" });
    rawName = parsed.filename;
    data = parsed.data;
  } else {
    rawName = searchParams.get("name") ?? (req.headers["x-filename"] as string | undefined);
    data = body;
  }

  if (data.length === 0) return sendJson(res, 400, { ok: false, error: "empty upload" });

  let dest = dropsDir();
  try {
    dest = storeDroppedFile(data, rawName);
  } catch (e) {
    errorLog("subscriber", { uploadWriteError: String(e), dest });
    return sendJson(res, 500, { ok: false, error: "write failed" });
  }

  const { notified, error } = await notifyDroppedFile(dest, relayNotify);
  debugLog("subscriber", { upload: dest, bytes: data.length, notified, notifyError: error });

  const body_out: Record<string, unknown> = { ok: true, path: dest, notified };
  if (error) body_out.error = error;
  return sendJson(res, 200, body_out);
}
