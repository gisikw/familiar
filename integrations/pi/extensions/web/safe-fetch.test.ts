import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { RefusedEncodingError, safeFetch } from "./safe-fetch.ts";

const TEXT = "hello from the far side of a decoder";
let server: http.Server;
let base = "";
const seen: Record<string, string | undefined> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen[req.url ?? ""] = req.headers["accept-encoding"] as string | undefined;
    switch (req.url) {
      case "/br": // unsolicited: we never ask for br, the server sends it anyway
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "br" });
        res.end(zlib.brotliCompressSync(Buffer.from(TEXT)));
        return;
      case "/zstd":
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "zstd" });
        res.end("not really zstd");
        return;
      case "/gzip":
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.end(zlib.gzipSync(Buffer.from(TEXT)));
        return;
      case "/deflate":
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "deflate" });
        res.end(zlib.deflateSync(Buffer.from(TEXT)));
        return;
      case "/redirect":
        res.writeHead(302, { location: "/plain" });
        res.end();
        return;
      default:
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(TEXT);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe("safeFetch", () => {
  test("refuses an unsolicited Brotli body without decoding it", async () => {
    const err = await safeFetch(`${base}/br`).catch((e) => e);
    expect(err).toBeInstanceOf(RefusedEncodingError);
    expect(err.encoding).toBe("br");
  });

  test("refuses other encodings it doesn't decode", async () => {
    const err = await safeFetch(`${base}/zstd`).catch((e) => e);
    expect(err).toBeInstanceOf(RefusedEncodingError);
  });

  test("asks for gzip/deflate only, even if the caller asked for br", async () => {
    await (await safeFetch(`${base}/plain`, { headers: { "Accept-Encoding": "br" } })).text();
    expect(seen["/plain"]).toBe("gzip, deflate");
  });

  test("decodes gzip and deflate itself", async () => {
    for (const p of ["/gzip", "/deflate"]) {
      const r = await safeFetch(`${base}${p}`);
      expect(r.ok).toBe(true);
      expect(r.headers.get("content-encoding")).toBeNull();
      expect(await r.text()).toBe(TEXT);
    }
  });

  test("passes plain bodies through", async () => {
    expect(await (await safeFetch(`${base}/plain`)).text()).toBe(TEXT);
  });

  test("does not follow redirects (callers validate each hop)", async () => {
    const r = await safeFetch(`${base}/redirect`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/plain");
  });
});
