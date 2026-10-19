import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// RULE (Kev, Oct 18 2026): anything an extension injects or rewrites on the way
// to the model must be a pure function of what's serialized in the session, or
// its output must be written back into the session. Otherwise a fork (or the
// parent after a restart) rebuilds a different prefix from disk than the live
// session sent, and the prompt cache misses from that point on.
//
// Pi's `context` hook is where an extension re-renders persisted messages per
// request, so every registered `context` handler, from every extension, is held
// to it here. What legitimately differs between a live message and its
// persisted copy: Pi's own `timestamp` on custom messages (send time live,
// persist time on disk; hours apart for nextTurn notices). So the same window
// is run twice, once with live timestamps and once with persisted ones, and the
// wire-visible output must match byte for byte.
//
// before_agent_start messages (timegap, l1, handoff) already comply: Pi
// persists the returned message, so it is memoized by construction.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 18, 16, 0);

function fixture(shift: number) {
  const custom = (customType: string, content: unknown, details: Record<string, unknown>, at: number) =>
    ({ role: "custom", customType, content, display: true, details, timestamp: at + shift });
  return [
    { role: "user", content: [{ type: "text", text: "morning" }], timestamp: T0 - HOUR },
    { role: "assistant", content: [{ type: "text", text: "hey" }], timestamp: T0 - HOUR + 5_000 },
    // Wake deliveries mid-session (no carrying user turn).
    custom("familiar.merge.v1", '<familiar-merge fork="f">\nok\n</familiar-merge>', { id: "m", mergedAt: new Date(T0 + 60_000).toISOString(), sentAt: T0 + 90_000 }, T0 + 90_000),
    custom("scheduler-event", '<scheduler-event id="e">\nx\n</scheduler-event>', { id: "e", event: { due_at: T0 + 100_000 }, sentAt: T0 + 400_000 }, T0 + 400_000),
    { role: "user", content: "back", timestamp: T0 + 3 * HOUR },
    // nextTurn notices: Pi orders them after the user message that carried them.
    custom("familiar.fork-dispatched.v1", "\n\nscheduled fork 01a14fbd-d702-7748-90ed-921484d739b5 started: free time\n(no action needed)",
      { forkId: "01a14fbd-d702-7748-90ed-921484d739b5", sentAt: T0 }, T0),
    // Legacy notice from before sentAt existed.
    custom("familiar.fork-dispatched.v1", [{ type: "text", text: "\n\nscheduled fork 01a1502b-b2b9-7384-b78f-2922bf5fd872 started" }],
      { forkId: "01a1502b-b2b9-7384-b78f-2922bf5fd872" }, T0 + 2 * HOUR),
    custom("time-awareness", "<system-reminder>The current time is now.</system-reminder>", {}, T0 + 3 * HOUR),
  ];
}

const wire = (messages: any[]) => JSON.stringify(messages.map(({ timestamp: _t, ...rest }) => rest));

test("every extension's context hook renders live and rebuilt-from-disk sessions identically", async () => {
  const piRoot = process.env.PI_PACKAGE_DIR;
  expect(piRoot, "PI_PACKAGE_DIR must point at the pi package").toBeTruthy();
  const { discoverAndLoadExtensions } = await import(pathToFileURL(join(piRoot!, "dist/core/extensions/loader.js")).href);
  const scratch = mkdtempSync(join(tmpdir(), "familiar-ctx-determinism-"));
  const agentDir = join(scratch, "agent");
  mkdirSync(agentDir, { recursive: true });
  try {
    const result = await discoverAndLoadExtensions([resolve(import.meta.dir, "..")], scratch, agentDir);
    // Every extension whose source registers a context hook must load, so its
    // hook is in the run below. (Others may fail here only because bun's
    // mock.module leaks across files in a full-suite run, e.g. typebox.)
    const root = resolve(import.meta.dir, "..");
    const registering = new Set<string>();
    for (const file of new Bun.Glob("*/**/*.{ts,mjs}").scanSync(root)) {
      if (/\.test\.|node_modules/.test(file)) continue;
      if (/\.on\(\s*["']context["']/.test(readFileSync(join(root, file), "utf8"))) registering.add(file.split("/")[0]);
    }
    expect([...registering]).toContain("scheduler");
    for (const err of result.errors) expect(registering.has(String(err.path).slice(root.length + 1).split("/")[0])).toBe(false);
    const hooks: { ext: string; fn: Function }[] = result.extensions.flatMap((ext: any) =>
      (ext.handlers.get("context") ?? []).map((fn: Function) => ({ ext: ext.resolvedPath, fn })));
    // Not vacuous: the scheduler's delivery stamp is a context hook today.
    expect(hooks.some((h) => h.ext.includes("/scheduler/"))).toBe(true);

    const run = async (shift: number) => {
      let messages: any[] = fixture(shift);
      for (const { fn } of hooks) {
        const out = await fn({ type: "context", messages }, {});
        if (out?.messages) messages = out.messages;
      }
      return messages;
    };
    // Live: custom timestamps are send times. Disk: persisted up to ~3h later.
    const live = await run(0);
    for (const shift of [7_000, 2 * HOUR + 53 * 60_000, 3 * HOUR]) {
      expect(wire(await run(shift))).toBe(wire(live));
    }
    // And it did stamp something, so the comparison exercised the hook.
    expect(wire(live)).toContain("queued 3h");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
