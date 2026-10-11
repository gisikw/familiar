import { expect, test } from "bun:test";
import { compactJob, listJobs, type ListingApi } from "./listing.ts";

const big = "x".repeat(20_000);
const job = (i: number, state: string) => ({
  id: `job-${i}`, state, harness: "pi", model: "m", cwd: "/long/path", idempotency_key: "k",
  workspace: { repo: "/r", worktree: "w", path: "/abs" }, prompt: big, artifacts: { id: "a" },
  created_at: `2026-10-11T00:00:${String(i).padStart(2, "0")}Z`,
  settlement: state === "done" ? { state, verdict: big, usage: {}, artifacts: [{ path: "p" }] } : undefined,
  question: state === "blocked" ? { id: "q1", prompt: "pick?", options: ["a", "b"] } : undefined,
  last_progress: { message: "working", detail: { big } },
});

function fakeApi(jobs: any[], paged = true): ListingApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listPage(states, limit, offset) {
      calls.push(`page ${states.join(",")} ${limit} ${offset}`);
      if (!paged) return null;
      const m = jobs.filter((j) => !states.length || states.includes(j.state)).reverse();
      return { jobs: m.slice(offset, offset + limit), total: m.length };
    },
    async list() { calls.push("list"); return jobs; },
  };
}

test("compactJob trims bulky fields and keeps the actionable ones", () => {
  const c = compactJob(job(1, "done"));
  expect(JSON.stringify(c).length).toBeLessThan(800);
  expect(c.cwd).toBeUndefined();
  expect(c.artifacts).toBeUndefined();
  expect(c.workspace).toEqual({ repo: "/r", worktree: "w" });
  expect(c.settlement.verdict.length).toBeLessThanOrEqual(300);
  expect(c.progress).toBeUndefined();
  const b = compactJob(job(2, "blocked"));
  expect(b.question).toEqual({ id: "q1", prompt: "pick?", options: ["a", "b"] });
  expect(b.progress).toBe("working");
});

test("default listing: active first, then 5 newest settled, bounded", async () => {
  const jobs = [...Array.from({ length: 40 }, (_, i) => job(i, "done")), job(50, "running"), job(51, "blocked")];
  const api = fakeApi(jobs);
  const out = await listJobs(api, {});
  expect(out.active.map((j: any) => j.id)).toEqual(["job-51", "job-50"]);
  expect(out.jobs.map((j: any) => j.id)).toEqual(["job-39", "job-38", "job-37", "job-36", "job-35"]);
  expect(out.total).toBe(40);
  expect(JSON.stringify(out).length).toBeLessThan(8_000);
});

test("offset pages settled only; state filters one state", async () => {
  const jobs = Array.from({ length: 12 }, (_, i) => job(i, i % 2 ? "done" : "failed"));
  const api = fakeApi(jobs);
  const page2 = await listJobs(api, { offset: 5 });
  expect(page2.active).toBeUndefined();
  expect(page2.jobs[0].id).toBe("job-6");
  const failed = await listJobs(api, { state: "failed" });
  expect(failed.jobs.every((j: any) => j.state === "failed")).toBe(true);
  expect(failed.total).toBe(6);
});

test("legacy golemd falls back to local paging", async () => {
  const jobs = Array.from({ length: 8 }, (_, i) => job(i, "done"));
  const api = fakeApi(jobs, false);
  const out = await listJobs(api, {});
  expect(api.calls).toContain("list");
  expect(out.jobs[0].id).toBe("job-7");
  expect(out.jobs[0].prompt.length).toBeLessThanOrEqual(160);
});
