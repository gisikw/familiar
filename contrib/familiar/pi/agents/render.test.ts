/* Focused tests for the agents_* compact/expandable renderers (pure logic).
 *
 * We test the pure text builders that index.ts wraps in `new Text(...)`:
 *   (1) the semantic summarize* helpers — the collapse/expand semantics,
 *       especially that the artifact base64 body and the full dispatch prompt
 *       are hidden when collapsed;
 *   (2) callText / resultText end-to-end (with an identity theme), proving the
 *       hiding/expanding and the error/partial handling.
 *
 * The module under test has NO dependency on pi's TUI package, so this runs
 * under bun without pi's node_modules.
 *
 * Run: bun test contrib/familiar/pi/agents/render.test.ts
 */
import { test, expect } from "bun:test";
import {
  preview,
  firstText,
  summarizeJob,
  summarizeCapabilities,
  summarizeArtifacts,
  summarizeArtifactFetch,
  callText,
  resultText,
  type AgentsTheme,
  type AgentsResult,
} from "./render.ts";

// Identity theme: colors are no-ops so we can assert on the plain text content.
const theme: AgentsTheme = {
  fg: (_c, t) => t,
  bg: (_c, t) => t,
  bold: (t) => t,
  italic: (t) => t,
  underline: (t) => t,
};

/* (1) semantic builders ----------------------------------------------------- */

test("preview truncates long text with an ellipsis, leaves short text intact", () => {
  expect(preview("hello", 10)).toBe("hello");
  const p = preview("a".repeat(200), 60);
  expect(p.length).toBeLessThanOrEqual(60);
  expect(p.endsWith("…")).toBe(true);
});

test("firstText returns the first text content part", () => {
  const r: AgentsResult = { content: [{ type: "text", text: "boom" }] };
  expect(firstText(r)).toBe("boom");
  expect(firstText({ content: [] })).toBe("");
});

test("summarizeJob: blocked question is the headline, with options", () => {
  const job = {
    id: "j1",
    state: "blocked",
    model: "claude-sonnet",
    workspace: { project: "demo", worktree: "wt-a" },
    question: { prompt: "Which database should I use?", options: ["postgres", "sqlite"] },
  };
  const s = summarizeJob(job as Record<string, unknown>);
  expect(s).toContain("blocked");
  expect(s).toContain("#j1");
  expect(s).toContain("Which database should I use?");
  expect(s).toContain("postgres");
  expect(s).toContain("sqlite");
});

test("summarizeJob: terminal state shows the verdict", () => {
  const job = {
    id: "j2",
    state: "done",
    model: "claude-sonnet",
    workspace: { repo: "golem", ref: "main", worktree: "wt-b" },
    settlement: { verdict: "All tests green, PR opened." },
  };
  const s = summarizeJob(job as Record<string, unknown>);
  expect(s).toContain("done");
  expect(s).toContain("#j2");
  expect(s).toContain("All tests green, PR opened.");
});

test("summarizeJob: running state is concise (no verdict)", () => {
  const s = summarizeJob({ id: "j3", state: "running", model: "claude-sonnet" } as Record<string, unknown>);
  expect(s).toContain("running");
  expect(s).toContain("#j3");
  expect(s).not.toContain("—");
});

test("summarizeCapabilities: counts + clone flag; expanded lists harnesses/projects", () => {
  const caps = {
    harnesses: { "claude-code": { models: ["sonnet", "opus"] }, "golem-cli": { models: ["mini"] } },
    projects: [{ name: "golem", description: "the daemon" }, { name: "docs" }],
    clone_enabled: true,
  };
  const c = summarizeCapabilities(caps as Record<string, unknown>);
  expect(c).toContain("2 harnesses");
  expect(c).toContain("2 projects");
  expect(c).toContain("clones on");
  const e = summarizeCapabilities(caps as Record<string, unknown>, { expanded: true });
  expect(e).toContain("claude-code: sonnet, opus");
  expect(e).toContain("golem — the daemon");
});

test("summarizeArtifacts: count + concise list; expanded lists all", () => {
  const arts = [
    { path: "/a/report.md", size: 120 },
    { path: "/b/out.txt", size: 30 },
    { path: "/c/log.txt", size: 5 },
    { path: "/d/x", size: 1 },
    { path: "/e/y", size: 2 },
  ];
  const c = summarizeArtifacts(arts);
  expect(c).toContain("5 artifacts");
  expect(c).toContain("/a/report.md (120B)");
  expect(c).toContain("+1 more");
  expect(c).not.toContain("/e/y");
  const e = summarizeArtifacts(arts, { expanded: true });
  expect(e).toContain("/e/y");
  expect(e).not.toContain("+1 more");
});

test("summarizeArtifactFetch: NEVER renders the base64 body (collapsed or expanded)", () => {
  const b64 = "QUJDREVG".repeat(2000) + "ZndBQ1pCTQ==";
  const d = { id: "j9", path: "/artifacts/report.md", encoding: "base64", data: b64 };
  const c = summarizeArtifactFetch(d as Record<string, unknown>);
  expect(c).toContain("/artifacts/report.md");
  expect(c).toContain("#j9");
  expect(c).not.toContain(b64);
  expect(c).toContain("(body hidden)");
  const e = summarizeArtifactFetch(d as Record<string, unknown>, { expanded: true });
  expect(e).toContain("/artifacts/report.md");
  expect(e).toContain("encoding: base64");
  expect(e).not.toContain(b64);
  expect(e).toContain("full body in model context");
});

/* (2) callText / resultText end-to-end -------------------------------------- */

const LONG_PROMPT =
  "Please implement feature Z with these exact steps: " + "step-".repeat(60) + "END_TOKEN_QWERTY";

test("callText(dispatch): full prompt hidden when collapsed, inspectable when expanded", () => {
  const args = { prompt: LONG_PROMPT, harness: "claude-code", model: "sonnet", project: "golem", worktree: "wt" };
  const collapsed = callText("agents_dispatch", args, theme, { expanded: false });
  const expanded = callText("agents_dispatch", args, theme, { expanded: true });
  expect(collapsed).not.toContain("END_TOKEN_QWERTY");
  expect(collapsed).toContain("dispatch");
  expect(expanded).toContain("END_TOKEN_QWERTY");
});

test("resultText(artifact_fetch): base64 never rendered, metadata shown expanded", () => {
  const b64 = "QUJDREVG".repeat(2000) + "ZndBQ1pCTQ==";
  const result: AgentsResult = {
    content: [{ type: "text", text: JSON.stringify({ id: "j9", path: "/a.md", data: b64 }) }],
    details: { id: "j9", path: "/a.md", encoding: "base64", data: b64 },
  };
  const collapsed = resultText("agents_artifact_fetch", result, { expanded: false }, theme, {});
  const expanded = resultText("agents_artifact_fetch", result, { expanded: true }, theme, {});
  expect(collapsed).not.toContain(b64);
  expect(collapsed).toContain("/a.md");
  expect(expanded).not.toContain(b64);
  expect(expanded).toContain("encoding: base64");
});

test("resultText: isError shows the thrown error message (failure is a throw)", () => {
  const result: AgentsResult = { content: [{ type: "text", text: "golemd 404: job j1 not found" }], details: {} };
  const out = resultText("agents_status", result, { expanded: false }, theme, { isError: true });
  expect(out).toContain("✗");
  expect(out).toContain("golemd 404: job j1 not found");
});

test("resultText: isPartial shows a running indicator", () => {
  const out = resultText("agents_dispatch", { content: [], details: undefined }, { isPartial: true }, theme, {});
  expect(out).toContain("running");
});

test("resultText(status list): count when collapsed, all jobs when expanded", () => {
  const jobs = [
    { id: "j1", state: "done", settlement: { verdict: "ok" } },
    { id: "j2", state: "running" },
    { id: "j3", state: "blocked", question: { prompt: "pick one" } },
    { id: "j4", state: "failed" },
    { id: "j5", state: "running" },
  ];
  const result: AgentsResult = { content: [{ type: "text", text: JSON.stringify(jobs) }], details: jobs };
  const collapsed = resultText("agents_status", result, { expanded: false }, theme, {});
  const expanded = resultText("agents_status", result, { expanded: true }, theme, {});
  expect(collapsed).toContain("5 jobs");
  expect(collapsed).toContain("+1 more");
  expect(expanded).toContain("#j5");
  expect(expanded).not.toContain("+1 more");
});

test("resultText(status list): paginated envelope shows page size and total", () => {
  const env = {
    total: 42,
    offset: 0,
    limit: 5,
    jobs: [
      { id: "j1", state: "done", settlement: { verdict: "ok" } },
      { id: "j2", state: "running" },
    ],
  };
  const result: AgentsResult = { content: [{ type: "text", text: JSON.stringify(env) }], details: env };
  const collapsed = resultText("agents_status", result, { expanded: false }, theme, {});
  const expanded = resultText("agents_status", result, { expanded: true }, theme, {});
  expect(collapsed).toContain("2 jobs (of 42)");
  expect(collapsed).toContain("#j1");
  expect(expanded).toContain("2 jobs (of 42)");
  expect(expanded).toContain("#j2");
});
