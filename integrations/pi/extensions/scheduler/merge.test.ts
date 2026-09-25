import { expect, test } from "bun:test";
import { renderScheduledEvent } from "./index.ts";

const merge = { id:"m1", due_at:1, target:"instance:parent", origin:"fork", source:"imp.merge", priority:2, type:"merge", summary:"I fixed it", body:JSON.stringify({summary:"I fixed it",forkSessionId:"fork",forkSessionFile:"/state/fork.jsonl",branchEntryId:"branch",firstEntryId:"first",lastEntryId:"last",turnCount:4,forkedFurther:false,mergedAt:"2026-01-01T00:00:00Z"}),urgency:"wake" as const,state:"delivered" as const,created_at:1 };

test("wake merge events become attributed durable custom messages", () => {
  const message = renderScheduledEvent(merge);
  expect(message.customType).toBe("familiar.merge.v1");
  expect(message.display).toBe(true);
  expect(message.content).toContain("fork=\"fork\"");
  expect(message.content).toContain("divergence=\"4\"");
  expect(message.content).toContain("full record: /state/fork.jsonl entries first..last");
  expect(message.details.mergedAt).toBe("2026-01-01T00:00:00Z");
});

test("soft merge is a short next-turn notice", () => {
  const message = renderScheduledEvent({...merge, urgency:"soft"});
  expect(message.customType).toBe("familiar.merge.v1");
  expect(message.content).toBe("fork fork merged: I fixed it");
});
