/* ============================================================================
 * Voice tap-to-talk state machine — unit tests. No microphone, no DOM.
 * Run with:  nix develop .#stt -c bun test services/gateway/web/voice-state.test.js
 * ============================================================================
 *
 * Exercises every legal transition, the double-tap / race guards, cancel from
 * each active state, empty-capture short-circuit, and the error→idle recovery.
 * The machine is pure: we assert on returned { state, actions } only.
 */
import { expect, test, describe } from "bun:test";
import {
  VoiceStateMachine,
  STATES,
  INTENTS,
  ACTIONS,
} from "./voice-state.js";

const types = (r) => r.actions.map((a) => a.type);

describe("VoiceStateMachine happy path", () => {
  test("full lifecycle idle → recording → finalizing → idle", () => {
    const sm = new VoiceStateMachine();
    expect(sm.state).toBe(STATES.IDLE);
    expect(sm.isActive()).toBe(false);

    // First tap: request mic.
    let r = sm.dispatch(INTENTS.TOGGLE);
    expect(sm.state).toBe(STATES.REQUESTING);
    expect(types(r)).toEqual([ACTIONS.REQUEST_MIC, ACTIONS.NOTIFY]);
    expect(sm.isActive()).toBe(true);

    // Mic ready: start recording.
    r = sm.dispatch(INTENTS.MIC_READY);
    expect(sm.state).toBe(STATES.RECORDING);
    expect(types(r)).toEqual([ACTIONS.START_RECORDER, ACTIONS.NOTIFY]);

    // Second tap: stop.
    r = sm.dispatch(INTENTS.TOGGLE);
    expect(sm.state).toBe(STATES.FINALIZING);
    expect(types(r)).toEqual([ACTIONS.STOP_RECORDER, ACTIONS.NOTIFY]);

    // Capture flushed a non-empty blob: upload.
    const take = { blob: { size: 42 }, empty: false };
    r = sm.dispatch(INTENTS.CAPTURE_STOPPED, take);
    expect(sm.state).toBe(STATES.FINALIZING);
    expect(types(r)).toEqual([ACTIONS.UPLOAD]);
    expect(r.actions[0].take).toBe(take);

    // Server accepted + dispatched: idle.
    r = sm.dispatch(INTENTS.SUBMIT_DONE);
    expect(sm.state).toBe(STATES.IDLE);
    expect(types(r)).toEqual([ACTIONS.DISCARD, ACTIONS.NOTIFY]);
    expect(sm.isActive()).toBe(false);
  });
});

describe("guards against double taps / races", () => {
  test("second TOGGLE while requesting is swallowed (no second mic)", () => {
    const sm = new VoiceStateMachine();
    sm.dispatch(INTENTS.TOGGLE);
    const r = sm.dispatch(INTENTS.TOGGLE); // impatient double-press
    expect(sm.state).toBe(STATES.REQUESTING);
    expect(r.actions).toEqual([]);
  });

  test("SUBMIT_DONE arriving in wrong state does nothing", () => {
    const sm = new VoiceStateMachine();
    const r = sm.dispatch(INTENTS.SUBMIT_DONE);
    expect(sm.state).toBe(STATES.IDLE);
    expect(r.actions).toEqual([]);
  });

  test("CAPTURE_STOPPED while recording (not yet stopped) is ignored", () => {
    const sm = new VoiceStateMachine();
    sm.dispatch(INTENTS.TOGGLE);
    sm.dispatch(INTENTS.MIC_READY);
    const r = sm.dispatch(INTENTS.CAPTURE_STOPPED, { blob: {}, empty: false });
    expect(sm.state).toBe(STATES.RECORDING);
    expect(r.actions).toEqual([]);
  });
});

describe("cancel / escape unwinds from any active state", () => {
  test("cancel while requesting → discard + idle", () => {
    const sm = new VoiceStateMachine();
    sm.dispatch(INTENTS.TOGGLE);
    const r = sm.dispatch(INTENTS.CANCEL);
    expect(sm.state).toBe(STATES.IDLE);
    expect(types(r)).toEqual([ACTIONS.DISCARD, ACTIONS.NOTIFY]);
  });

  test("cancel while recording → discard + idle (audio dropped)", () => {
    const sm = new VoiceStateMachine();
    sm.dispatch(INTENTS.TOGGLE);
    sm.dispatch(INTENTS.MIC_READY);
    const r = sm.dispatch(INTENTS.CANCEL);
    expect(sm.state).toBe(STATES.IDLE);
    expect(types(r)).toEqual([ACTIONS.DISCARD, ACTIONS.NOTIFY]);
  });

  test("cancel while finalizing (upload in flight) → discard + idle", () => {
    const sm = new VoiceStateMachine();
    sm.dispatch(INTENTS.TOGGLE);
    sm.dispatch(INTENTS.MIC_READY);
    sm.dispatch(INTENTS.TOGGLE);
    const r = sm.dispatch(INTENTS.CANCEL);
    expect(sm.state).toBe(STATES.IDLE);
    expect(types(r)).toEqual([ACTIONS.DISCARD, ACTIONS.NOTIFY]);
  });

  test("cancel at idle is a pure no-op", () => {
    const sm = new VoiceStateMachine();
    const r = sm.dispatch(INTENTS.CANCEL);
    expect(sm.state).toBe(STATES.IDLE);
    expect(r.actions).toEqual([]);
  });
});

describe("empty capture short-circuits (no empty take posted)", () => {
  test("stop with empty blob returns to idle without UPLOAD", () => {
    const sm = new VoiceStateMachine();
    sm.dispatch(INTENTS.TOGGLE);
    sm.dispatch(INTENTS.MIC_READY);
    sm.dispatch(INTENTS.TOGGLE);
    const r = sm.dispatch(INTENTS.CAPTURE_STOPPED, { empty: true });
    expect(sm.state).toBe(STATES.IDLE);
    expect(types(r)).toEqual([ACTIONS.DISCARD, ACTIONS.NOTIFY]);
  });
});

describe("error surfaces + recovers on next tap", () => {
  test("permission denied → error state carrying detail", () => {
    const sm = new VoiceStateMachine();
    sm.dispatch(INTENTS.TOGGLE);
    const r = sm.dispatch(INTENTS.MIC_DENIED, "microphone permission denied");
    expect(sm.state).toBe(STATES.ERROR);
    expect(types(r)).toEqual([ACTIONS.DISCARD, ACTIONS.NOTIFY]);
    const notify = r.actions.find((a) => a.type === ACTIONS.NOTIFY);
    expect(notify.detail).toBe("microphone permission denied");
    expect(sm.isActive()).toBe(false);
  });

  test("submit failure → error, then a tap clears it back to idle", () => {
    const sm = new VoiceStateMachine();
    sm.dispatch(INTENTS.TOGGLE);
    sm.dispatch(INTENTS.MIC_READY);
    sm.dispatch(INTENTS.TOGGLE);
    sm.dispatch(INTENTS.CAPTURE_STOPPED, { blob: { size: 9 }, empty: false });
    let r = sm.dispatch(INTENTS.SUBMIT_FAILED, "stt 500");
    expect(sm.state).toBe(STATES.ERROR);
    expect(sm.lastError).toBe("stt 500");

    // Next F8 clears the error (does NOT immediately re-record).
    r = sm.dispatch(INTENTS.TOGGLE);
    expect(sm.state).toBe(STATES.IDLE);
    expect(types(r)).toEqual([ACTIONS.NOTIFY]);
    expect(sm.lastError).toBe(null);

    // The tap AFTER recovery starts a fresh capture.
    r = sm.dispatch(INTENTS.TOGGLE);
    expect(sm.state).toBe(STATES.REQUESTING);
    expect(types(r)).toEqual([ACTIONS.REQUEST_MIC, ACTIONS.NOTIFY]);
  });
});
