/* ============================================================================
 * Golem agents tools — tool-result helper (pure, no pi dependency)
 * ============================================================================
 * Builds the model-facing tool result and enforces pi's custom-tool error
 * contract. Kept free of pi imports so it is unit-testable under bun.
 * ========================================================================== */

/** The model-facing shape every agents_* tool returns. */
export type AgentToolResult = { content: { type: "text"; text: string }[]; details?: unknown };

/** Wrap a structured value as the tool result (full JSON is what the model gets). */
export const result = (value: unknown): AgentToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  details: value,
});

/**
 * Run a tool body and return its result — OR throw, per pi's custom-tool
 * contract. A FAILED execution is signalled by THROWING from execute(): pi then
 * marks the tool result `isError: true` and reports the message to the model.
 * Returning an `isError` property does NOT do that (the agent loop reports
 * isError:false for any returned value), which is the bug this fixes. We
 * normalize any failure to an Error and rethrow, preserving a useful
 * model-facing message (the TUI renderer surfaces it from the error result).
 */
export const run = async (f: () => Promise<unknown>): Promise<AgentToolResult> => {
  try {
    const value = await f();
    return result(value);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
};
