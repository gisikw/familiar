import { thinkingLevel } from "./protocol.mjs";

/** Apply only the immutable configuration stored at admission. Pi owns model
 * capability clamping and branch-session history persistence. */
export async function configureBranchSession(session, modelRuntime, record) {
  const captured = thinkingLevel(record.thinkingLevel);
  const model = record.model;
  if (
    !model ||
    typeof model.provider !== "string" ||
    typeof model.id !== "string"
  )
    throw new Error("invalid persisted branch model");
  const available = modelRuntime.getModel(model.provider, model.id);
  if (!available) throw new Error("branch model unavailable");
  await session.setModel(available);
  session.setThinkingLevel(captured);
  return session.thinkingLevel;
}
