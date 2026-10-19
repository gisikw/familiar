import { expect, test } from "bun:test";
import { compactDuration } from "../lib/time.ts";
import { stampDeliveries, stampText, withSentAt } from "./stamp.ts";

process.env.FAMILIAR_TZ = "America/Chicago";
// Sat Oct 3 2026, 3:41 PM CDT = 20:41Z
const T341 = Date.UTC(2026, 9, 3, 20, 41);
const T355 = Date.UTC(2026, 9, 3, 20, 55);

test("compactDuration is terse", () => {
  expect(compactDuration(45_000)).toBe("45s");
  expect(compactDuration(14 * 60_000)).toBe("14m");
  expect(compactDuration(125 * 60_000)).toBe("2h5m");
  expect(compactDuration(3 * 86_400_000)).toBe("3d");
});

test("soft merge riding his message gets at= and queued=", () => {
  const out = stampDeliveries([
    { role: "user", content: "hi", timestamp: T355 },
    { role: "custom", customType: "familiar.merge.v1", content: "\n\nfork abc merged: done", timestamp: T341, details: { mergedAt: new Date(T341).toISOString() } },
  ]);
  expect(out[1].content).toBe("\n\n[Sat 3:41 PM, queued 14m] fork abc merged: done");
});

test("wake merge tag carries attributes; no queued when prompt", () => {
  const out = stampDeliveries([
    { role: "assistant", content: [], timestamp: T341 - 5000 },
    { role: "custom", customType: "familiar.merge.v1", content: '<familiar-merge fork="f">\nok\n</familiar-merge>', timestamp: T341 + 2000, details: { mergedAt: new Date(T341).toISOString() } },
  ]);
  expect(out[1].content).toBe('<familiar-merge at="Sat 3:41 PM" fork="f">\nok\n</familiar-merge>');
});

test("scheduler-event uses its due time, so a redelivery shows how late it is", () => {
  const out = stampDeliveries([
    { role: "assistant", content: [], timestamp: 0 },
    { role: "custom", customType: "scheduler-event", content: '<scheduler-event id="e">\nx\n</scheduler-event>', timestamp: T355, details: { event: { due_at: T341 }, sentAt: T355 } },
  ]);
  expect(out[1].content).toStartWith('<scheduler-event at="Sat 3:41 PM" queued="14m" id="e">');
});

test("fork-dispatched notice and array content; unrelated messages untouched", () => {
  const user = { role: "user", content: [{ type: "text", text: "yo" }], timestamp: T355 };
  const other = { role: "custom", customType: "time-awareness", content: "<system-reminder>t</system-reminder>", timestamp: T355 };
  const out = stampDeliveries([
    user,
    { role: "custom", customType: "familiar.fork-dispatched.v1", content: [{ type: "text", text: "\n\nscheduled fork X started: free time" }], timestamp: T341, details: { sentAt: T341 } },
    other,
  ]);
  expect(out[0]).toBe(user);
  expect(out[2]).toBe(other);
  expect((out[1].content as { text: string }[])[0].text).toBe("\n\n[Sat 3:41 PM, queued 14m] scheduled fork X started: free time");
});

test("stamping is idempotent on tagged items and deterministic", () => {
  const once = stampText('<scheduler-event id="e">\nx</scheduler-event>', T341, undefined);
  expect(stampText(once, T341, 60_000)).toBe(once);
  const msgs = [{ role: "user", content: "a", timestamp: T355 }, { role: "custom", customType: "familiar.merge.v1", content: "fork m merged: y", timestamp: T341, details: {} }];
  expect(stampDeliveries(msgs)).toEqual(stampDeliveries(msgs));
});

// The fork-cache bug (Oct 18 2026): live, a nextTurn notice's timestamp is its
// send time; rebuilt from disk it's when Pi persisted it (hours later). The
// stamp must not care: same session, same bytes, whether live or rebuilt.
test("live and rebuilt-from-disk renderings are byte-identical", () => {
  const T1100 = Date.UTC(2026, 9, 18, 16, 0);
  const T1353 = Date.UTC(2026, 9, 18, 18, 53);
  const persisted = (live: any[]) => live.map((m) => m.role === "custom" ? { ...m, timestamp: T1353 + 7_000 } : m);
  const live = [
    { role: "user", content: "hey", timestamp: T1100 - 3_600_000 },
    { role: "assistant", content: [], timestamp: T1100 - 3_590_000 },
    // wake merge delivered mid-run, scheduler event redelivered late, soft fork notice
    { role: "custom", customType: "familiar.merge.v1", content: '<familiar-merge fork="f">\nok\n</familiar-merge>', timestamp: T1100, details: { mergedAt: new Date(T1100 - 120_000).toISOString(), sentAt: T1100 } },
    { role: "custom", customType: "scheduler-event", content: '<scheduler-event id="e">\nx\n</scheduler-event>', timestamp: T1100, details: { event: { due_at: T1100 - 600_000 }, sentAt: T1100 } },
    { role: "user", content: "back", timestamp: T1353 },
    { role: "custom", customType: "familiar.fork-dispatched.v1", content: "\n\nscheduled fork 01a14fbd-d702-7748-90ed-921484d739b5 started: free time", timestamp: T1100, details: { forkId: "01a14fbd-d702-7748-90ed-921484d739b5", sentAt: T1100 } },
  ];
  // The wire carries content, not Pi's timestamp field.
  const wire = (ms: any[]) => JSON.stringify(stampDeliveries(ms).map((m: any) => m.content));
  expect(wire(persisted(live))).toBe(wire(live));
  expect((stampDeliveries(live)[5] as any).content).toBe("\n\n[Sun 11:00 AM, queued 2h53m] scheduled fork 01a14fbd-d702-7748-90ed-921484d739b5 started: free time");
});

test("legacy fork notice without sentAt falls back to its UUIDv7 fork id, not the message timestamp", () => {
  const id = "01a14fbd-d702-7748-90ed-921484d739b5"; // 11:00:03 AM CDT Oct 18
  const msg = (timestamp: number) => [
    { role: "user", content: "back", timestamp: Date.UTC(2026, 9, 18, 18, 53) },
    { role: "custom", customType: "familiar.fork-dispatched.v1", content: "\n\nscheduled fork started", timestamp, details: { forkId: id } },
  ];
  const a = stampDeliveries(msg(Date.UTC(2026, 9, 18, 16, 0, 3)));
  const b = stampDeliveries(msg(Date.UTC(2026, 9, 18, 18, 53, 33)));
  expect((a[1] as any).content).toBe((b[1] as any).content);
  expect((a[1] as any).content).toBe("\n\n[Sun 11:00 AM, queued 2h52m] scheduled fork started");
});

test("withSentAt only touches stamped types and never overwrites", () => {
  expect(withSentAt({ customType: "time-awareness", details: {} }, 5e12)).toEqual({ customType: "time-awareness", details: {} });
  expect(withSentAt({ customType: "scheduler-event", details: { id: "x" } }, 5e12).details).toEqual({ id: "x", sentAt: 5e12 });
  expect(withSentAt({ customType: "scheduler-event", details: { sentAt: 4e12 } }, 5e12).details).toEqual({ sentAt: 4e12 });
});
