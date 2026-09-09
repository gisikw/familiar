import { GolemClient } from "../../../../contrib/familiar/pi/agents/api.ts";
import { ChildBackend } from "../../../../packages/background/backend.mjs";

// The only legacy Golem dependency in Background's host/runtime. A ledger
// adapter replaces this factory, not the branch scheduler or ownership rules.
export function createChildBackend() {
  const raw = process.env.FAMILIAR_BACKGROUND_CHILD_SOFT_BYTES;
  if (raw && !/^[1-9][0-9]*$/.test(raw))
    throw new Error("invalid child soft limit");
  const transport = new GolemClient(undefined, undefined, {
    timeoutMs: 5000,
    responseBytes: 4 * 1024 * 1024,
  });
  // Read-only reconciliation. Absence is not proof that an in-flight create
  // cannot finish later, so the host keeps that intent quarantined.
  Object.assign(transport, {
    lookupCreate: async (key: string) =>
      (await transport.list()).find(
        (job: any) => job.idempotency_key === key,
      ) ?? null,
  });
  return new ChildBackend(transport, { softBytes: raw ? Number(raw) : null });
}
export type BackgroundChildBackend = ReturnType<typeof createChildBackend>;
