import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const sdk = process.env.PI_PACKAGE_DIR ? await import(pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js"))) : null;
for (const kind of ["admission", "merge"]) for (const boundary of ["control:appending", "control:written", "control:fsynced"]) {
  test(`installed canonical SIGKILL: ${kind} at ${boundary}`, { skip: !sdk }, () => {
    const root = mkdtempSync(join(tmpdir(), "canonical-kill-"));
    try {
      const child = spawnSync(process.execPath, [fileURLToPath(new URL("./canonical-crash-worker.mjs", import.meta.url)), root, kind, boundary], { env: process.env });
      assert.equal(child.signal, "SIGKILL", child.stderr?.toString());
      const file = readFileSync(join(root, "file"), "utf8");
      const lines = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
      // Append-only: once bytes are written they survive process death (page
      // cache), so a SIGKILL after the write is committed; only a crash before
      // any byte is written (control:appending) leaves the parent unchanged.
      const committed = ["control:written", "control:fsynced"].includes(boundary);
      const expected = 1 + (committed ? kind === "admission" ? 2 : 1 : 0);
      assert.equal(lines.length, expected + 1);
      const reopened = sdk.SessionManager.open(file);
      assert.equal(reopened.getEntries().length, expected);
      for (let n = 2; n < lines.length; n++) assert.equal(lines[n].parentId, lines[n - 1].id);
      assert.equal(reopened.buildSessionContext().messages.length, committed ? 1 : 0);
      assert.ok(reopened.buildSessionContext().messages.every((m) => m.role !== "assistant"));
      const leaf = reopened.getLeafId();
      reopened.commitRuntimeControl(reopened.getSessionId(), leaf, [{ type: "custom", customType: "after-recovery", data: {} }]);
      assert.throws(() => reopened.commitRuntimeControl(reopened.getSessionId(), leaf, [{ type: "custom", customType: "replay", data: {} }]), /conflict/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

// Literal injected syscall failures for the canonical append path, not only the
// SIGKILL lifecycle markers above nor the runtime-control marker proxies: a real
// closeSync/fsyncSync/writeSync exception (an Error carrying a code) must take the
// identical catch/quarantine clause, and a genuine short write must be absorbed
// by the writeAllSync loop. Selective module mocking of "fs" requires
// --experimental-test-module-mocks, so the injection runs in a child node here in
// the Background suite (Node 22), where mocking "fs" for the Pi SessionManager is
// robust. It is deliberately NOT placed in runtime-control.test.mjs: that test is
// executed during the Pi build under Node 24.19, whose CJS module-mock path copies
// namedExports onto the real fs exports and cannot redefine fs's non-configurable
// "constants", crashing every Pi module that require()s fs.
test(
  "installed canonical literal syscall injection: close/fsync/write quarantine, short-write loop",
  { skip: !sdk },
  () => {
    const root = mkdtempSync(join(tmpdir(), "canonical-syscall-"));
    try {
      const worker = join(root, "syscall-inject.worker.mjs");
      writeFileSync(
        worker,
        `import assert from "node:assert/strict";
import { mock } from "node:test";
import * as realFs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
let mode = null;
const fail = (n) => { const e = new Error("INJECTED " + n); e.code = "EIO"; throw e; };
mock.module("fs", { namedExports: { ...realFs,
  closeSync: (fd) => { if (mode === "close") { mode = null; fail("closeSync"); } return realFs.closeSync(fd); },
  fsyncSync: (fd) => { if (mode === "fsync") { mode = null; fail("fsyncSync"); } return realFs.fsyncSync(fd); },
  writeSync: (...a) => {
    if (mode === "writethrow") { mode = null; fail("writeSync"); }
    if (mode === "shortwrite") { mode = null; const [fd, buf, off = 0, len] = a; const n = len == null ? buf.length - off : len; return realFs.writeSync(fd, buf, off, Math.max(1, Math.floor(n / 2))); }
    return realFs.writeSync(...a);
  },
} });
const sdk = await import(pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js")).href);
const root = mkdtempSync(join(tmpdir(), "canonical-syscall-w-"));
try {
  const input = [{ type: "message", message: { role: "user", content: "u", timestamp: 1 } }];
  {
    const sm = sdk.SessionManager.create(root, root);
    const f = sm.getSessionFile();
    mode = "close";
    assert.throws(() => sm.commitRuntimeControl(sm.getSessionId(), sm.getLeafId(), input), /INJECTED closeSync/);
    assert.equal(sm.isRuntimeControlQuarantined(), true, "real closeSync failure quarantines");
    assert.throws(() => sm.appendCustomEntry("x", {}), /quarantined/, "no unsafe continuation after close fault");
    assert.equal(sdk.SessionManager.open(f).getEntries().length, 1, "batch durable before close fault");
  }
  {
    const sm = sdk.SessionManager.create(root, root);
    mode = "fsync";
    assert.throws(() => sm.commitRuntimeControl(sm.getSessionId(), sm.getLeafId(), input), /INJECTED fsyncSync/);
    assert.equal(sm.isRuntimeControlQuarantined(), true, "real fsync failure quarantines");
    assert.equal(sm.getEntries().length, 0, "memory not published on fsync fault");
  }
  {
    const sm = sdk.SessionManager.create(root, root);
    mode = "writethrow";
    assert.throws(() => sm.commitRuntimeControl(sm.getSessionId(), sm.getLeafId(), input), /INJECTED writeSync/);
    assert.equal(sm.isRuntimeControlQuarantined(), true, "real write failure quarantines");
    assert.equal(sm.getEntries().length, 0);
  }
  {
    const sm = sdk.SessionManager.create(root, root);
    const f = sm.getSessionFile();
    mode = "shortwrite";
    sm.commitRuntimeControl(sm.getSessionId(), sm.getLeafId(), input);
    assert.equal(sm.isRuntimeControlQuarantined(), false, "short write is absorbed by the write loop");
    assert.equal(sdk.SessionManager.open(f).getEntries().length, 1, "short write still yields a durable batch");
  }
  console.log("literal-syscall-injection ok");
} finally { rmSync(root, { recursive: true, force: true }); }
`,
      );
      const child = spawnSync(
        process.execPath,
        ["--experimental-test-module-mocks", worker],
        { env: process.env },
      );
      assert.equal(child.status, 0, child.stderr?.toString());
      assert.match(child.stdout.toString(), /literal-syscall-injection ok/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
