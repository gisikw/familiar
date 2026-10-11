// Curated job listing for agents_status. A long-lived golemd accumulates
// hundreds of settled jobs whose bodies carry full prompts and verdicts; the
// raw list outgrew the transport budget (4 MiB at ~560 jobs). The tool view is
// therefore: live work first (always small), then a page of the most recent
// settled jobs, every job trimmed to a one-line-worthy summary. Full detail is
// one `agents_status {id}` away.

export const ACTIVE_STATES = ["pending", "assigned", "starting", "running", "blocked", "cancelling"] as const;
export const SETTLED_STATES = ["done", "failed", "cancelled", "timeout"] as const;
export const PAGE = 5;
const ACTIVE_CAP = 50;

type Page = { jobs: any[]; total: number };
export interface ListingApi {
  /** Server-paged newest-first list; null when golemd predates paging. */
  listPage(states: readonly string[], limit: number, offset: number): Promise<Page | null>;
  list(state?: string): Promise<any>;
}

const clip = (v: unknown, n: number): string | undefined => {
  if (typeof v !== "string" || !v) return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

export function compactJob(j: any): any {
  if (!j || typeof j !== "object") return j;
  const ws = j.workspace && typeof j.workspace === "object" ? j.workspace : undefined;
  const out: any = {
    id: j.id,
    state: j.state,
    harness: j.harness,
    model: j.model,
    workspace: ws ? { project: ws.project, repo: ws.repo, worktree: ws.worktree } : undefined,
    created_at: j.created_at,
    updated_at: j.updated_at,
    prompt: clip(j.prompt, 160),
  };
  const progress = j.last_progress?.message ?? (typeof j.last_progress === "string" ? j.last_progress : undefined);
  if (progress && !SETTLED_STATES.includes(j.state)) out.progress = clip(progress, 120);
  if (j.question && typeof j.question === "object") {
    out.question = { id: j.question.id, prompt: clip(j.question.prompt ?? j.question.text, 600), options: j.question.options };
  }
  if (j.settlement && typeof j.settlement === "object") {
    out.settlement = { state: j.settlement.state, verdict: clip(j.settlement.verdict, 300) };
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

const newest = (a: any, b: any) => String(b?.created_at || "").localeCompare(String(a?.created_at || ""));

export async function listJobs(api: ListingApi, p: { state?: string; offset?: number }): Promise<any> {
  const offset = Math.max(0, Math.floor(p.offset || 0));
  const state = p.state?.trim() || undefined;
  if (state) {
    const page = await api.listPage([state], PAGE, offset);
    if (page) return { state, total: page.total, offset, limit: PAGE, jobs: page.jobs.map(compactJob) };
  } else {
    const settled = await api.listPage(SETTLED_STATES, PAGE, offset);
    if (settled) {
      const out: any = { total: settled.total, offset, limit: PAGE };
      if (offset === 0) {
        const active = await api.listPage(ACTIVE_STATES, ACTIVE_CAP, 0);
        out.active = (active?.jobs ?? []).map(compactJob);
        if ((active?.total ?? 0) > ACTIVE_CAP) out.active_total = active!.total;
      }
      out.jobs = settled.jobs.map(compactJob);
      return out;
    }
  }
  // Legacy golemd (no paging): fetch everything and page locally. May still
  // exceed the transport budget on a large registry; upgrading golemd fixes it.
  const all = await api.list(state);
  const jobs = Array.isArray(all) ? [...all].sort(newest) : [];
  return { total: jobs.length, offset, limit: PAGE, jobs: jobs.slice(offset, offset + PAGE).map(compactJob) };
}
