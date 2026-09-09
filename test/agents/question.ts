// A real Pi UI question exercising Herdr's existing optional blocked event.
// It is a proof fixture, not a Familiar lifecycle detector or settlement tool.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "proof_question",
    label: "Proof question",
    description: "Ask the live human for permission to proceed.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      pi.events.emit("herdr:blocked", {
        active: true,
        label: "Proof: proceed?",
      });
      try {
        const answer = await ctx.ui.input("Proof: proceed?", "type yes");
        return {
          content: [{ type: "text", text: answer || "interrupted" }],
          details: {},
        };
      } finally {
        pi.events.emit("herdr:blocked", { active: false });
      }
    },
  });
}
