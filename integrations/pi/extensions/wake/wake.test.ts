import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WakeRuntime, type WakeClock } from "./runtime.ts";
import { wakePaths } from "./store.ts";

class FakeClock implements WakeClock {
  current = 1_000_000;
  serial = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.current;
  id = () => `id-${++this.serial}`;
  setTimeout = (callback: () => void, milliseconds: number) => {
    const id = ++this.serial;
    this.timers.set(id, { at: this.current + milliseconds, callback });
    return id;
  };
  clearTimeout = (timer: unknown) => { this.timers.delete(timer as number); };
  advance(milliseconds: number): void {
    this.current += milliseconds;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.current)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "familiar-wake-"));
  roots.push(root);
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const host = {
    sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
  } as never;
  const clock = new FakeClock();
  return { root, sent, host, clock };
}

function modes(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe("durable wake runtime", () => {
  test("restores a future wake after session/process teardown", () => {
    const f = fixture();
    const first = new WakeRuntime(f.host, f.root, f.clock);
    const wake = first.schedule("always", "future", 60_000);
    first.stop();

    const restored = new WakeRuntime(f.host, f.root, f.clock);
    restored.start();
    f.clock.advance(59_999);
    expect(f.sent).toHaveLength(0);
    f.clock.advance(1);
    expect(f.sent).toHaveLength(1);
    expect(JSON.stringify(f.sent[0]?.message)).toContain("future");
    expect(fs.existsSync(path.join(wakePaths(f.root).pending, `${wake.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(wakePaths(f.root).fired, `${wake.id}.json`))).toBe(true);
  });

  test("fires an elapsed, unclaimed wake promptly on startup", () => {
    const f = fixture();
    const first = new WakeRuntime(f.host, f.root, f.clock);
    first.schedule("always", "overdue", 10_000);
    first.stop();
    f.clock.advance(20_000);

    new WakeRuntime(f.host, f.root, f.clock).start();
    expect(f.sent).toHaveLength(0); // session_start itself is allowed to finish
    f.clock.advance(0);
    expect(f.sent).toHaveLength(1);
    expect(JSON.stringify(f.sent[0]?.message)).toContain("overdue");
  });

  test("fresh user/worklist activity durably cancels unless_wakened only", () => {
    const f = fixture();
    const runtime = new WakeRuntime(f.host, f.root, f.clock);
    const nap = runtime.schedule("unless_wakened", "nap", 30_000);
    const alarm = runtime.schedule("always", "alarm", 30_000);
    f.clock.advance(1);
    runtime.freshInput();
    runtime.stop();

    const paths = wakePaths(f.root);
    expect(fs.existsSync(path.join(paths.pending, `${nap.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(paths.pending, `${alarm.id}.json`))).toBe(true);
    const restored = new WakeRuntime(f.host, f.root, f.clock);
    restored.start();
    f.clock.advance(30_000);
    expect(f.sent).toHaveLength(1);
    expect(JSON.stringify(f.sent[0]?.message)).toContain("alarm");
  });

  test("quarantines corrupt records and enforces private modes", () => {
    const f = fixture();
    const paths = wakePaths(f.root);
    fs.mkdirSync(paths.pending, { recursive: true });
    fs.writeFileSync(path.join(paths.pending, "broken.json"), "{not-json", { mode: 0o644 });

    const runtime = new WakeRuntime(f.host, f.root, f.clock);
    runtime.start();
    const wake = runtime.schedule("always", "permissions", 10_000);
    expect(f.sent).toHaveLength(0);
    expect(fs.readdirSync(paths.quarantine)).toHaveLength(1);
    expect(fs.readdirSync(paths.pending)).toEqual([`${wake.id}.json`]);
    expect(modes(paths.root)).toBe(0o700);
    expect(modes(paths.pending)).toBe(0o700);
    expect(modes(path.join(paths.pending, `${wake.id}.json`))).toBe(0o600);
  });

  test("a claimed wake is never repeated after a crash/restart", () => {
    const f = fixture();
    const runtime = new WakeRuntime(f.host, f.root, f.clock);
    runtime.schedule("always", "once", 10_000);
    f.clock.advance(10_000);
    expect(f.sent).toHaveLength(1);
    runtime.stop();
    new WakeRuntime(f.host, f.root, f.clock).start();
    f.clock.advance(10_000);
    expect(f.sent).toHaveLength(1);
  });
});
