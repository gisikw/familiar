// extensions/subagent/native-agent-args.ts — the child (pi) subagent's explicit
// extension set and argv.
//
// Kept in its own dependency-free module (no typebox / pi API imports) so the
// exact child extension SET and ORDER is a pure, regression-testable value
// rather than an inline literal buried in the tool handler.
//
// WHY THE ORDER IS LOAD-BEARING
// A pi subagent boots with `--no-extensions` and an EXPLICIT `-e` list, so the
// child's provider route is entirely ours to compose. Order is load-and-
// registration order: pi loads `-e` paths sequentially in argv order, awaiting
// each factory (pi extensions/loader.ts loadExtensionsInternal), and provider
// registrations for the SAME id apply last-writer-wins with a defined-value
// merge (pi core/model-runtime.ts registerProvider — verified against pi
// 0.84.x). So for the child's `anthropic` provider:
//
//   1. anthropic-gateway registers `{ baseUrl: ANTHROPIC_BASE_URL }` (tiamat's
//      route) — but only when that env var is set. This is the FALLBACK.
//   2. claude-driver loads AFTER it. Its factory returns an awaited async
//      `ready` that binds the double-loopback and re-registers `anthropic`
//      with the in-process loopback baseUrl — the setup-token / credentials
//      (double-loopback) path. Because it registers LAST, it takes PROVIDER
//      AUTHORITY over the gateway's baseUrl.
//
// claude-driver is a hard NO-OP (its factory returns before any registration)
// unless a canonical Claude credential is resolvable (claude_oauth_token /
// claude_credentials_json). When absent, only step 1 registered, so tiamat's
// gateway route stands unchanged. This is why claude-driver MUST come after
// anthropic-gateway: authority only inverts in the credentialled case, and the
// no-credential case cleanly falls back. `web` registers no provider, so its
// position is route-neutral; it stays last to preserve its historical slot.
import * as path from "node:path";

export interface NativeAgentArgsOptions {
  /** extensions/ root — the parent dir of anthropic-gateway/, claude-driver/, web/. */
  extDir: string;
  sessionDir: string;
  sessionId: string;
  model?: string;
}

export function nativeAgentArgs(opts: NativeAgentArgsOptions): string[] {
  const ext = (name: string) => path.join(opts.extDir, name, "index.ts");
  return [
    "--no-extensions",
    // Fallback route first: tiamat's anthropic-gateway (no-op when
    // ANTHROPIC_BASE_URL is unset).
    "-e", ext("anthropic-gateway"),
    // Authority second: claude-driver re-registers `anthropic` at the
    // in-process loopback when canonical Claude credentials are present, and is
    // a complete no-op otherwise. Loading last is what gives it authority.
    "-e", ext("claude-driver"),
    // Route-neutral: web registers tools, not a provider.
    "-e", ext("web"),
    "--no-skills",
    "--no-context-files",
    "--session-dir", opts.sessionDir,
    "--session-id", opts.sessionId,
    ...(opts.model ? ["--model", opts.model] : []),
  ];
}
