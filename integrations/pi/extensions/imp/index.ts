import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ImpIngress } from "./ingress.mjs";

/** Owns Familiar's one private, per-resident Imp socket. Area implementations
 * are fixed process Symbols so load order is irrelevant and absent areas fail
 * explicitly without affecting the socket or another area. */
export default function (pi: ExtensionAPI) {
  let ingress: ImpIngress | undefined;
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || ingress) return;
    const candidate = new ImpIngress();
    try {
      await candidate.start();
      ingress = candidate;
    } catch {
      await candidate.stop().catch(() => {});
      ctx.ui.notify("Private Imp ingress unavailable", "warning");
    }
  });
  pi.on("session_shutdown", async () => {
    const old = ingress;
    ingress = undefined;
    await old?.stop();
  });
}
