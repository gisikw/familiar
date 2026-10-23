/* --- safeFetch: fetch without Brotli ----------------------------------------
 *
 * Node2Shell (CVE-2026-111497, Oct 2026): a crafted Brotli stream corrupts
 * memory in Brotli's decoder (1.0.3 - 1.2.0). Node's global fetch (undici)
 * decodes whatever `Content-Encoding` the *server* declares, regardless of what
 * we asked for, so an Accept-Encoding header alone is not a defence. This tool
 * fetches arbitrary, model-chosen URLs, which makes it the exposure.
 *
 * safeFetch speaks HTTP via node:http/https, which never decompresses on its
 * own. We ask for gzip/deflate only, decode those ourselves, and refuse any
 * other declared encoding (br, zstd, unknown) before a single byte reaches a
 * decoder. Defence in depth: the runtime also links a patched Brotli
 * (nix/brotli-cve-2026-111497.nix), but this path should not depend on that.
 *
 * Returns a standard web Response so callers keep using .ok/.status/.headers/
 * .body. Redirects are never followed here (callers validate each hop).
 */
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import zlib from "node:zlib";

export const ALLOWED_ENCODINGS = new Set(["", "identity", "gzip", "x-gzip", "deflate"]);

export class RefusedEncodingError extends Error {
  encoding: string;
  url: string;
  constructor(encoding: string, url: string) {
    super(`refused Content-Encoding "${encoding}" from ${url} (only gzip/deflate/identity are decoded)`);
    this.name = "RefusedEncodingError";
    this.encoding = encoding;
    this.url = url;
  }
}

export interface SafeFetchInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function safeFetch(input: string | URL, init: SafeFetchInit = {}): Promise<Response> {
  const url = typeof input === "string" ? new URL(input) : input;
  const mod = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (!mod) return Promise.reject(new Error(`unsupported protocol: ${url.protocol}`));
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  for (const k of Object.keys(headers)) if (k.toLowerCase() === "accept-encoding") delete headers[k];
  headers["Accept-Encoding"] = "gzip, deflate";

  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: "GET", headers, signal: init.signal }, (res) => {
      const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
      if (!ALLOWED_ENCODINGS.has(encoding)) {
        res.destroy();
        reject(new RefusedEncodingError(encoding, url.href));
        return;
      }
      let stream: NodeJS.ReadableStream = res;
      if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(zlib.createGunzip());
      else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
      stream.on("error", () => {}); // surfaced through the web stream reader instead

      const outHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        // The body handed back is already decoded; don't advertise otherwise.
        if (k === "content-encoding" || k === "content-length") continue;
        for (const one of Array.isArray(v) ? v : [v]) outHeaders.append(k, one);
      }
      const status = res.statusCode ?? 0;
      const nullBody = status === 204 || status === 205 || status === 304;
      if (nullBody) res.resume();
      // Response rejects statuses outside 200-599 (e.g. 1xx never reach here).
      resolve(new Response(nullBody ? null : (Readable.toWeb(stream as Readable) as ReadableStream), {
        status: status >= 200 && status <= 599 ? status : 502,
        statusText: res.statusMessage,
        headers: outHeaders,
      }));
    });
    req.on("error", reject);
    req.end();
  });
}
