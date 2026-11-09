import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { debugLog, errorLog } from "../src/debug.ts";

/** Run `fn` with the given logging env and return what it wrote to stderr. */
function captureStderr(env: Record<string, string | undefined>, fn: () => void): string[] {
  const saved = {
    FAMILIAR_LOG_PATH: process.env.FAMILIAR_LOG_PATH,
    FAMILIAR_DEBUG_LEVEL: process.env.FAMILIAR_DEBUG_LEVEL,
  };
  const original = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as never;
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    process.stderr.write = original;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return lines;
}

function tempBase(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gateway-debug-")), "log.jsonl");
}

async function fileWritten(file: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file, "utf8");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return "";
}

test("an error reaches stderr even when the sidecar goes nowhere", () => {
  // kestrel's layout: FAMILIAR_LOG_PATH set, every sidecar a /dev/null link.
  const base = tempBase();
  fs.symlinkSync("/dev/null", `${base}.subscriber`);
  const lines = captureStderr({ FAMILIAR_LOG_PATH: base, FAMILIAR_DEBUG_LEVEL: "error" }, () => {
    errorLog("subscriber", { ttsError: "Error: tts 503", key: "19:0" });
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[error:subscriber\] /);
  const body = JSON.parse(lines[0].slice("[error:subscriber] ".length));
  assert.deepEqual(body.error, { ttsError: "Error: tts 503", key: "19:0" });
  assert.ok(!Number.isNaN(Date.parse(body.at)));
});

test("an error still lands in the sidecar when one is configured", async () => {
  const base = tempBase();
  captureStderr({ FAMILIAR_LOG_PATH: base, FAMILIAR_DEBUG_LEVEL: "error" }, () => {
    errorLog("subscriber", { dispatchError: "boom", id: 7 });
  });
  const written = await fileWritten(`${base}.subscriber`);
  assert.deepEqual(JSON.parse(written), { dispatchError: "boom", id: 7 });
});

test("without a sidecar an error is written to stderr once", () => {
  const lines = captureStderr({ FAMILIAR_LOG_PATH: undefined, FAMILIAR_DEBUG_LEVEL: "error" }, () => {
    errorLog("fleet", { requestError: "nope" });
  });
  assert.equal(lines.length, 1);
});

test("level off silences errors", () => {
  const lines = captureStderr({ FAMILIAR_LOG_PATH: undefined, FAMILIAR_DEBUG_LEVEL: "off" }, () => {
    errorLog("subscriber", { ttsError: "x" });
  });
  assert.deepEqual(lines, []);
});

test("debug lines keep going only to the sidecar", async () => {
  const base = tempBase();
  const lines = captureStderr({ FAMILIAR_LOG_PATH: base, FAMILIAR_DEBUG_LEVEL: "debug" }, () => {
    debugLog("egress", { event: "segment" });
  });
  assert.deepEqual(lines, []);
  assert.deepEqual(JSON.parse(await fileWritten(`${base}.egress`)), { event: "segment" });
});

test("debug lines are dropped at error level", () => {
  const lines = captureStderr({ FAMILIAR_LOG_PATH: undefined, FAMILIAR_DEBUG_LEVEL: "error" }, () => {
    debugLog("egress", { event: "segment" });
  });
  assert.deepEqual(lines, []);
});
