import { expect, test } from "bun:test";
import { MERGE_UNSEEN, PULLED_BY_KEV, renderScheduledEvent, forkRequest, parseDndMode } from "./index.ts";

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
  expect(message.content).toBe("\n\nfork fork merged: I fixed it\n" + MERGE_UNSEEN);
});

test("soft notices lead with a blank line; wake events do not", () => {
  const note = { ...merge, type: "notify", body: "", summary: "check the thing" };
  expect(renderScheduledEvent({ ...note, urgency: "soft" }).content.startsWith("\n\n<scheduler-event ")).toBe(true);
  expect(renderScheduledEvent(note).content.startsWith("<scheduler-event ")).toBe(true);
  expect(renderScheduledEvent(merge).content.startsWith("<familiar-merge ")).toBe(true);
  expect(renderScheduledEvent(merge).content).toContain(">\n" + MERGE_UNSEEN + "\nI fixed it\n");
});

const stubBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ ...JSON.parse(merge.body), summary: "CVE fixed on 3 of 5", stub: true, status: "blocked", headline: "CVE fixed on 3 of 5", label: "cve", inboxId: "m1", ...extra });

test("a Soft Disturb stub names the fork, status and headline, not the return", () => {
  const message = renderScheduledEvent({ ...merge, body: stubBody() });
  expect(message.customType).toBe("familiar.merge.v1");
  expect(message.details.id).toBe("m1");
  expect(message.content).toContain('<familiar-return fork="fork" status="blocked">');
  expect(message.content).toContain("cve returned blocked: CVE fixed on 3 of 5");
  expect(message.content).toContain("imp pull fork");
  expect(message.content).not.toContain("full record");
});

test("a quiet stub leads with the soft separator", () => {
  expect(renderScheduledEvent({ ...merge, urgency: "soft", body: stubBody() }).content.startsWith("\n\n<familiar-return ")).toBe(true);
});

test("a return Kev tapped in Open says so instead of 'unseen'", () => {
  const pulled = { ...merge, body: JSON.stringify({ ...JSON.parse(merge.body), claimed: true, pulledBy: "kevin" }) };
  const content = renderScheduledEvent(pulled).content;
  expect(content).toContain(PULLED_BY_KEV);
  expect(content).not.toContain(MERGE_UNSEEN);
});

test("hidden scheduled forks are ambient; --ambient alone is too", () => {
  const ev = (body: object) => ({ ...merge, type: "fork", body: JSON.stringify({ task: "watch", ...body }) });
  expect(forkRequest(ev({ hidden: true })).ambient).toBe(true);
  expect(forkRequest(ev({ ambient: true })).ambient).toBe(true);
  expect(forkRequest(ev({})).ambient).toBe(false);
});

test("dnd soft parses", () => {
  expect(parseDndMode(JSON.stringify({ mode: "soft", expiresAt: Date.now() + 60_000 }))).toBe("soft");
});
