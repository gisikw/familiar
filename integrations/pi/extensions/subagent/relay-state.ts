import * as fs from "node:fs";
import * as path from "node:path";

/** Recoverable serialization for settlement delivery. A claim is explicitly
 * non-terminal; only commitRelay records durable ownership. */
export const relayClaimPath = (marker: string): string => `${marker}.claim`;

export function takeRelayClaim(marker: string): boolean {
  try {
    fs.writeFileSync(relayClaimPath(marker), `${process.pid}\n${Date.now()}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function releaseRelayClaim(marker: string): void {
  try { fs.unlinkSync(relayClaimPath(marker)); } catch { /* absent */ }
}

/** Called at bootstrap, when the prior extension instance cannot still own it. */
export function reconcileRelayClaim(marker: string): void {
  releaseRelayClaim(marker);
}

/** Terminal settlements and blocked interrupts use the same transient claim
 * protocol; both must be recoverable after the owning process dies. */
export function reconcilePassClaims(jobDir: string, pass: number): void {
  reconcileRelayClaim(path.join(jobDir, `relayed-${pass}`));
  reconcileRelayClaim(path.join(jobDir, `blocked-${pass}`));
}

export function commitRelay(marker: string): void {
  if (fs.existsSync(marker)) return;
  fs.writeFileSync(marker, new Date().toISOString(), { flag: "wx", mode: 0o600 });
}
