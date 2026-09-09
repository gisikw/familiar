import { spawnSync } from "node:child_process";
import { openSync, closeSync, fstatSync, constants, lstatSync } from "node:fs";
import { join } from "node:path";

/** Linux flock locks the open-file description shared with inherited fd 3.
 * The short-lived flock process acquires it; the HOST retains that same fd.
 * There is no helper whose death could release a still-live host's lease.
 * Never unlink the inode. Kernel process death releases the last descriptor.
 */
export async function acquireHostLease(root) {
  const directory = lstatSync(root);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.mode & 0o077
  )
    throw new Error("unsafe host root");
  const fd = openSync(
    join(root, "owner.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  let closed = false;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077 || stat.nlink !== 1)
      throw new Error("unsafe host lease");
    const result = spawnSync("flock", ["-n", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
      timeout: 5000,
    });
    if (result.status !== 0)
      throw new Error("host already owned or lease unavailable");
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return {
    assertOwned() {
      if (closed) throw new Error("host lease lost");
    },
    async release() {
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
    },
  };
}
