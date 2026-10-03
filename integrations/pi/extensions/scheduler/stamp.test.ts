import { expect, test } from "bun:test";
import { compactDuration } from "../lib/time.ts";
import { stampDeliveries, stampText } from "./stamp.ts";

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
    { role: "custom", customType: "scheduler-event", content: '<scheduler-event id="e">\nx\n</scheduler-event>', timestamp: T355, details: { event: { due_at: T341 } } },
  ]);
  expect(out[1].content).toStartWith('<scheduler-event at="Sat 3:41 PM" queued="14m" id="e">');
});

test("fork-dispatched notice and array content; unrelated messages untouched", () => {
  const user = { role: "user", content: [{ type: "text", text: "yo" }], timestamp: T355 };
  const other = { role: "custom", customType: "time-awareness", content: "<system-reminder>t</system-reminder>", timestamp: T355 };
  const out = stampDeliveries([
    user,
    { role: "custom", customType: "familiar.fork-dispatched.v1", content: [{ type: "text", text: "\n\nscheduled fork X started: free time" }], timestamp: T341 },
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
