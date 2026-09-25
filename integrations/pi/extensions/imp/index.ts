import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ImpIngress, IMP_BRANCH_HANDLER } from "./ingress.mjs";

/** Owns Familiar's one private, per-resident Imp socket. Area implementations
 * are fixed process Symbols so load order is irrelevant and absent areas fail
 * explicitly without affecting the socket or another area. */
export default function (pi: ExtensionAPI) {
  let ingress: ImpIngress | undefined;
  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) process.env.FAMILIAR_SESSION_FILE = sessionFile;
    process.env.FAMILIAR_NODE ??= process.execPath;
    (process as any)[IMP_BRANCH_HANDLER] = {
      handle(request: { operation: string; args: { text?: unknown } }) {
        if (request.operation !== "merge" || typeof request.args.text !== "string")
          throw Object.assign(new Error("invalid branch operation"), { code: "invalid_request" });
        pi.appendEntry("familiar.merge-sent.v1", { summary: request.args.text });
        setTimeout(() => void ctx.shutdown(), 25);
        return { exiting: true };
      },
    };
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
    if ((process as any)[IMP_BRANCH_HANDLER]) delete (process as any)[IMP_BRANCH_HANDLER];
    delete process.env.FAMILIAR_SESSION_FILE;
    await old?.stop();
  });
}
