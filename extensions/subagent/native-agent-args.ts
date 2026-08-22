// extensions/subagent/native-agent-args.ts — the child (pi) subagent's explicit
// extension set and argv.
//
// Kept in its own dependency-free module (no typebox / pi API imports) so the
// exact child extension set is a pure, regression-testable value rather than an
// inline literal buried in the tool handler. Native children route Anthropic
// traffic only through the configured external anthropic-gateway; Claude Code
// invocation and transcript projection do not belong inside Familiar.
import * as path from "node:path";

export interface NativeAgentArgsOptions {
  /** extensions/ root — the parent dir of anthropic-gateway/ and web/. */
  extDir: string;
  sessionDir: string;
  sessionId: string;
  model?: string;
}

export function nativeAgentArgs(opts: NativeAgentArgsOptions): string[] {
  const ext = (name: string) => path.join(opts.extDir, name, "index.ts");
  return [
    "--no-extensions",
    // Dedicated external gateway owns Anthropic routing and compatibility.
    "-e", ext("anthropic-gateway"),
    // Route-neutral: web registers tools, not a provider.
    "-e", ext("web"),
    "--no-skills",
    "--no-context-files",
    "--session-dir", opts.sessionDir,
    "--session-id", opts.sessionId,
    ...(opts.model ? ["--model", opts.model] : []),
  ];
}
