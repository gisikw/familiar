import { spawn } from "node:child_process";
import { openSync, closeSync, lstatSync } from "node:fs";
import { join } from "node:path";

/** Kernel flock held by a pipe-lifetime helper, not a timestamp/PID heuristic.
 * EOF on host death releases ownership. Never unlink the lock inode.
 */
export async function acquireHostLease(root) {
  const file = join(root, "owner.lock");
  try { closeSync(openSync(file, "wx", 0o600)); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error("unsafe host lease");
  const child = spawn("flock", ["-n", file, "sh", "-c", "printf READY; cat >/dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
  let exited = false;
  const exit = new Promise((resolve) => child.once("exit", () => { exited = true; resolve(); }));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("host lease deadline")), 5000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("host lease unavailable")); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("host already owned")); });
      child.stdout.once("data", (data) => { clearTimeout(timer); data.toString() === "READY" ? resolve() : reject(new Error("invalid lease handshake")); });
    });
  } catch (error) { child.kill(); throw error; }
  return {
    assertOwned() { if (exited) throw new Error("host lease lost"); },
    async release() { child.stdin.end(); await exit; },
  };
}
