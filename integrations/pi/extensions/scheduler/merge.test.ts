import { expect, test } from "bun:test";
import { renderScheduledEvent } from "./index.ts";

test("merge events become attributed durable custom messages", () => {
  const message = renderScheduledEvent({ id:"m1", due_at:1, target:"instance:parent", origin:"fork", source:"imp.merge", priority:2, type:"merge", summary:"I fixed it", body:JSON.stringify({summary:"I fixed it",forkSessionId:"fork",forkSessionFile:"/state/fork.jsonl",branchEntryId:"branch",firstEntryId:"first",lastEntryId:"last",turnCount:4,forkedFurther:false}),state:"delivered",created_at:1 });
  expect(message.customType).toBe("familiar.merge.v1");
  expect(message.display).toBe(true);
  expect(message.content).toContain("fork=\"fork\"");
  expect(message.content).toContain("divergence=\"4\"");
  expect(message.content).toContain("full record: /state/fork.jsonl entries first..last");
});
