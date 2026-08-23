import { describe, expect, test } from "bun:test";
import { VoiceStatusController } from "./relay.ts";

describe("subscriber voice status", () => {
  test("renders phases, emits the public event, and rejects stale commands", () => {
    const widgets: unknown[][] = [];
    const events: unknown[][] = [];
    const pi = { events: { emit: (...args: unknown[]) => events.push(args) } } as any;
    const voice = new VoiceStatusController(pi, 1000);
    voice.ctx = {
      hasUI: true,
      ui: { setWidget: (...args: unknown[]) => widgets.push(args) },
    } as any;

    expect(voice.enact({ type: "voice-status", phase: "capturing", timestamp: 10, seq: 1, takeId: 7 })).toBe(true);
    expect(widgets.at(-1)?.[1]).toEqual(["🎙 Listening…"]);
    expect(voice.enact({ type: "voice-status", phase: "idle", timestamp: 9, seq: 99, takeId: 7 })).toBe(false);
    expect(widgets.at(-1)?.[1]).toEqual(["🎙 Listening…"]);
    expect(voice.enact({ type: "voice-status", phase: "transcribing", timestamp: 10, seq: 2, takeId: 7 })).toBe(true);
    expect(widgets.at(-1)?.[1]).toEqual(["🎙 Transcribing…"]);
    expect(voice.enact({ type: "voice-status", phase: "idle", timestamp: 11, seq: 3, takeId: 7 })).toBe(true);
    expect(widgets.at(-1)).toEqual(["voice-status", undefined]);
    expect(events.at(-1)).toEqual(["voice:status", { phase: "idle", timestamp: 11, takeId: 7 }]);
  });

  test("self-clears and emits idle when a terminal relay event is lost", async () => {
    const widgets: unknown[][] = [];
    const events: unknown[][] = [];
    const voice = new VoiceStatusController({ events: { emit: (...args: unknown[]) => events.push(args) } } as any, 10);
    voice.ctx = { hasUI: true, ui: { setWidget: (...args: unknown[]) => widgets.push(args) } } as any;
    voice.enact({ type: "voice-status", phase: "capturing", timestamp: Date.now(), seq: 1 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(widgets.at(-1)).toEqual(["voice-status", undefined]);
    expect(events.at(-1)?.[1]).toMatchObject({ phase: "idle" });
  });
});
