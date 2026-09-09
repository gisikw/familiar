import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Pi's CLI deliberately supports fuzzy model selection. Familiar admission
 * does not. Validate startup/first request, without wrapping the foreground
 * harness or implementing any Herdr activity/settlement behavior. */
export default function (pi: ExtensionAPI) {
  const expected = process.env.FAMILIAR_AGENT_EXPECTED_MODEL;
  if (!expected) return;
  const key = Symbol.for("familiar.agents.initial-model.v1");
  const state = process as unknown as Record<symbol, string | undefined>;
  const exact = (ctx: ExtensionContext) => {
    if (state[key] === expected) return;
    if (`${ctx.model?.provider}/${ctx.model?.id}` !== expected) {
      process.stderr.write(
        "Familiar Agents: exact requested model was not selected; refusing fallback.\n",
      );
      process.exit(78);
    }
  };
  pi.on("session_start", (_event, ctx) => exact(ctx));
  pi.on("before_provider_headers", (_event, ctx) => {
    if (state[key] === expected) return;
    exact(ctx);
    state[key] = expected; // Later manual steering/reload remains possible.
  });
}
