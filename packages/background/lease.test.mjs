import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostLease } from "./lease.mjs";

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
  } finally { rmSync(root, { recursive: true, force: true }); }
});
