import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const sdk = process.env.PI_PACKAGE_DIR ? await import(pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js"))) : null;
for (const kind of ["admission", "merge"]) for (const boundary of ["control:written", "control:fsynced", "control:renamed", "control:directory-synced"]) {
  test(`installed canonical SIGKILL: ${kind} at ${boundary}`, { skip: !sdk }, () => {
    const root = mkdtempSync(join(tmpdir(), "canonical-kill-"));
    try {
      const child = spawnSync(process.execPath, [fileURLToPath(new URL("./canonical-crash-worker.mjs", import.meta.url)), root, kind, boundary], { env: process.env });
      assert.equal(child.signal, "SIGKILL", child.stderr?.toString());
      const file = readFileSync(join(root, "file"), "utf8");
      const lines = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
      const committed = ["control:renamed", "control:directory-synced"].includes(boundary);
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
