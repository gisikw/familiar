import assert from "node:assert/strict";
import test from "node:test";
import { Osc52Parser, MAX_B64, createOsc52Bridge, writeSystemClipboard } from "./osc52.js";

// Standard base64 for "hello" is aGVsbG8= (matches the Rust viewer's encoder).
const HELLO = "aGVsbG8=";

function seq(target, b64, term = "\x07") {
  return `\x1b]52;${target};${b64}${term}`;
}

test("parses a whole BEL-terminated clipboard-write sequence", () => {
  const p = new Osc52Parser();
  assert.deepEqual(p.feed(seq("c", HELLO)), ["hello"]);
});

test("parses an ST-terminated sequence too", () => {
  const p = new Osc52Parser();
  assert.deepEqual(p.feed(seq("c", HELLO, "\x1b\\")), ["hello"]);
});

test("ignores surrounding terminal bytes and does not consume them", () => {
  const p = new Osc52Parser();
  const out = p.feed(`before\x1b[0m${seq("c", HELLO)}after`);
  assert.deepEqual(out, ["hello"]);
});

test("reassembles a sequence split across arbitrary chunk boundaries", () => {
  const full = seq("c", HELLO);
  for (let cut = 1; cut < full.length; cut++) {
    const p = new Osc52Parser();
    const a = p.feed(full.slice(0, cut));
    const b = p.feed(full.slice(cut));
    assert.deepEqual([...a, ...b], ["hello"], `split at ${cut}`);
  }
});

test("reassembles a sequence split byte-by-byte", () => {
  const full = seq("c", HELLO);
  const p = new Osc52Parser();
  const out = [];
  for (const ch of full) out.push(...p.feed(ch));
  assert.deepEqual(out, ["hello"]);
});

test("handles two sequences in one chunk and across chunks", () => {
  const p = new Osc52Parser();
  assert.deepEqual(p.feed(seq("c", HELLO) + seq("c", "d29ybGQ=")), ["hello", "world"]);
});

// --- rejection / security bounds -----------------------------------------

test("rejects clipboard READ requests (target c, body ?)", () => {
  const p = new Osc52Parser();
  assert.deepEqual(p.feed("\x1b]52;c;?\x07"), []);
});

test("ignores non-write targets (primary selection p, others)", () => {
  const p = new Osc52Parser();
  assert.deepEqual(p.feed(seq("p", HELLO)), []);
  assert.deepEqual(p.feed(seq("s", HELLO)), []);
  assert.deepEqual(p.feed(seq("", HELLO)), []);
});

test("rejects a body that is not strict standard base64", () => {
  const p = new Osc52Parser();
  assert.deepEqual(p.feed(seq("c", "not*base64!!")), []);
  // URL-safe alphabet is not accepted.
  assert.deepEqual(p.feed(seq("c", "a-_b")), []);
  // whitespace inside the body is not accepted.
  assert.deepEqual(p.feed(seq("c", "aGVs bG8=")), []);
});

test("rejects base64 whose decoded bytes are not valid UTF-8", () => {
  const p = new Osc52Parser();
  // 0xff 0xfe is invalid UTF-8.
  assert.deepEqual(p.feed(seq("c", "//4=")), []);
});

test("rejects an empty payload", () => {
  const p = new Osc52Parser();
  assert.deepEqual(p.feed(seq("c", "")), []);
});

test("abandons an oversized unterminated body without unbounded buffering", () => {
  const p = new Osc52Parser();
  const huge = "A".repeat(MAX_B64 + 8);
  assert.deepEqual(p.feed(`\x1b]52;c;${huge}`), []);
  // Buffer must not retain the abandoned oversized body.
  assert.ok(p.buf.length <= 8, `buffer bounded, got ${p.buf.length}`);
  // A subsequent valid sequence still parses.
  assert.deepEqual(p.feed(seq("c", HELLO)), ["hello"]);
});

test("rejects a body over MAX_B64 even when terminated", () => {
  const p = new Osc52Parser();
  const huge = "A".repeat(MAX_B64 + 4); // multiple of 4, strict alphabet
  assert.deepEqual(p.feed(seq("c", huge)), []);
});

test("holds an incomplete sequence without emitting, then completes", () => {
  const p = new Osc52Parser();
  assert.deepEqual(p.feed("\x1b]52;c;aGVs"), []);
  assert.deepEqual(p.feed("bG8=\x07"), ["hello"]);
});

test("decodes multibyte UTF-8 selections", () => {
  const p = new Osc52Parser();
  const text = "café — 世界 🌍";
  const b64 = Buffer.from(text, "utf8").toString("base64");
  assert.deepEqual(p.feed(seq("c", b64)), [text]);
});

// --- bridge glue ----------------------------------------------------------

test("bridge routes decoded payload to the injected clipboard writer", async () => {
  const writes = [];
  const feed = createOsc52Bridge({
    writeClipboard: async (t) => { writes.push(t); return "async"; },
    onCopied: (info) => writes.push(info),
  });
  assert.equal(feed(seq("c", HELLO)), 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(writes, ["hello", { chars: 5, method: "async" }]);
});

test("bridge reports failure without throwing", async () => {
  const failures = [];
  const feed = createOsc52Bridge({
    writeClipboard: async () => { throw new Error("denied"); },
    onFailed: (err) => failures.push(err.message),
  });
  feed(seq("c", HELLO));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(failures, ["denied"]);
});

test("bridge does not invoke the writer for reads or rejects", async () => {
  let called = 0;
  const feed = createOsc52Bridge({ writeClipboard: async () => { called++; return "async"; } });
  feed("\x1b]52;c;?\x07");
  feed(seq("p", HELLO));
  await new Promise((r) => setImmediate(r));
  assert.equal(called, 0);
});

// --- writeSystemClipboard secure-context / fallback selection -------------

test("writeSystemClipboard uses async Clipboard API in a secure context", async () => {
  let wrote = null;
  const method = await writeSystemClipboard("hi", {
    isSecureContext: true,
    navigator: { clipboard: { writeText: async (t) => { wrote = t; } } },
  });
  assert.equal(method, "async");
  assert.equal(wrote, "hi");
});

test("writeSystemClipboard falls back to execCommand outside a secure context", async () => {
  const created = [];
  const fakeDoc = fakeDocument(created, true);
  const method = await writeSystemClipboard("hi", {
    isSecureContext: false,
    navigator: {},
    document: fakeDoc,
  });
  assert.equal(method, "exec");
  assert.equal(created[0].value, "hi");
  assert.equal(created[0].removed, true);
});

test("writeSystemClipboard throws when no clipboard API is available", async () => {
  await assert.rejects(
    writeSystemClipboard("hi", { isSecureContext: false, navigator: {}, document: undefined }),
    /no clipboard API/,
  );
});

test("writeSystemClipboard surfaces an execCommand rejection", async () => {
  const created = [];
  const fakeDoc = fakeDocument(created, false);
  await assert.rejects(
    writeSystemClipboard("hi", { isSecureContext: false, navigator: {}, document: fakeDoc }),
    /copy rejected/,
  );
  assert.equal(created[0].removed, true); // still cleaned up
});

function fakeDocument(created, execResult) {
  const body = { appendChild() {} };
  return {
    createElement() {
      const el = {
        style: {}, value: "", removed: false,
        setAttribute() {}, select() {}, setSelectionRange() {},
        remove() { el.removed = true; },
      };
      created.push(el);
      return el;
    },
    body,
    execCommand() { return execResult; },
  };
}
