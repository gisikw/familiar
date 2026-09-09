import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostLease } from "./lease.mjs";

test("kernel releases the host-held descriptor on actual SIGKILL, not helper/PID heuristics", async () => {
  const root = mkdtempSync(join(tmpdir(), "background-lease-kill-"));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./lease-crash-worker.mjs", import.meta.url)), root],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("owner died before ready")));
    });
    await assert.rejects(acquireHostLease(root), /already owned/);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    const replacement = await acquireHostLease(root);
    replacement.assertOwned();
    await replacement.release();
  } finally {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("one host writer lease: a second owner cannot start until drain releases the same inode", async () => {
  const root = mkdtempSync(join(tmpdir(), "background-lease-"));
  try {
    const first = await acquireHostLease(root);
    first.assertOwned();
    await assert.rejects(acquireHostLease(root), /already owned/);
    await first.release();
    assert.throws(() => first.assertOwned(), /lost/);
    const replacement = await acquireHostLease(root);
    replacement.assertOwned();
    await replacement.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
