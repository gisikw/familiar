// Pure, DOM-free tap-to-talk state machine for Familiar voice capture.
//
// Why a separate pure module: the browser layer (voice.js) owns getUserMedia,
// MediaRecorder, and fetch — none of which exist (or should be faked) under a
// headless test runner. This module owns only the *logic*: which state we are
// in, which transitions are legal, and which side effects the host must enact.
// It returns effects declaratively ({ actions: [...] }) so the whole tap →
// record → stop → upload → idle lifecycle can be exercised with plain function
// calls and zero microphone (see voice-state.test.js).
//
// Lifecycle (happy path):
//   idle --TOGGLE--> requesting --MIC_READY--> recording
//        --TOGGLE--> finalizing --CAPTURE_STOPPED--> finalizing(upload)
//        --SUBMIT_DONE--> idle
//
// Escape (CANCEL) unwinds from any active state back to idle, discarding audio.
// Any failure lands in a transient `error` state that the next tap clears.

export const STATES = Object.freeze({
  IDLE: "idle",
  REQUESTING: "requesting", // asked for mic; awaiting permission + recorder
  RECORDING: "recording",
  FINALIZING: "finalizing", // stopped; uploading + awaiting STT + dispatch
  ERROR: "error", // transient; cleared on next tap
});

// Intents fed in by the host.
export const INTENTS = Object.freeze({
  TOGGLE: "toggle", // Ctrl+Space
  CANCEL: "cancel", // Escape / unload
  MIC_READY: "mic_ready", // getUserMedia + recorder ready
  MIC_DENIED: "mic_denied", // permission denied / no device
  CAPTURE_STOPPED: "capture_stopped", // recorder flushed a blob
  SUBMIT_DONE: "submit_done", // /submit accepted + dispatched
  SUBMIT_FAILED: "submit_failed", // upload / STT / dispatch failure
});

// Declarative side effects the host enacts.
export const ACTIONS = Object.freeze({
  REQUEST_MIC: "request_mic", // call getUserMedia, build recorder
  START_RECORDER: "start_recorder",
  STOP_RECORDER: "stop_recorder", // graceful stop → expect CAPTURE_STOPPED
  DISCARD: "discard", // tear down stream/recorder, drop any audio
  UPLOAD: "upload", // POST the captured take to /submit
  NOTIFY: "notify", // surface the new state in the UI
});

export class VoiceStateMachine {
  constructor() {
    this.state = STATES.IDLE;
    this.lastError = null;
  }

  // Advance the machine. `detail` carries error text or the captured blob.
  // Returns { state, actions } — actions is an ordered list of ACTIONS the
  // host must perform. Illegal / redundant intents are ignored (empty actions),
  // which is exactly how double-taps and races are guarded.
  dispatch(intent, detail) {
    const from = this.state;
    const notify = (state) => ({ type: ACTIONS.NOTIFY, state, detail: this.lastError });

    switch (from) {
      case STATES.IDLE:
        if (intent === INTENTS.TOGGLE) {
          this.lastError = null;
          this.state = STATES.REQUESTING;
          return this._emit([{ type: ACTIONS.REQUEST_MIC }, notify(this.state)]);
        }
        return this._emit([]); // CANCEL at idle is a no-op

      case STATES.REQUESTING:
        // A second tap while we are still acquiring the mic is swallowed — the
        // guard against a permission-prompt double-fire opening two streams.
        if (intent === INTENTS.MIC_READY) {
          this.state = STATES.RECORDING;
          return this._emit([{ type: ACTIONS.START_RECORDER }, notify(this.state)]);
        }
        if (intent === INTENTS.MIC_DENIED) {
          this.lastError = detail || "microphone unavailable";
          this.state = STATES.ERROR;
          return this._emit([{ type: ACTIONS.DISCARD }, notify(this.state)]);
        }
        if (intent === INTENTS.CANCEL) {
          this.state = STATES.IDLE;
          return this._emit([{ type: ACTIONS.DISCARD }, notify(this.state)]);
        }
        return this._emit([]);

      case STATES.RECORDING:
        if (intent === INTENTS.TOGGLE) {
          // Stop gracefully; the flushed blob arrives later as CAPTURE_STOPPED.
          this.state = STATES.FINALIZING;
          return this._emit([{ type: ACTIONS.STOP_RECORDER }, notify(this.state)]);
        }
        if (intent === INTENTS.CANCEL) {
          this.state = STATES.IDLE;
          return this._emit([{ type: ACTIONS.DISCARD }, notify(this.state)]);
        }
        return this._emit([]);

      case STATES.FINALIZING:
        if (intent === INTENTS.CAPTURE_STOPPED) {
          // Empty capture (mic opened then immediately toggled off) → nothing
          // to transcribe; fall back to idle rather than posting an empty take.
          if (!detail || detail.empty) {
            this.state = STATES.IDLE;
            return this._emit([{ type: ACTIONS.DISCARD }, notify(this.state)]);
          }
          return this._emit([{ type: ACTIONS.UPLOAD, take: detail }]);
        }
        if (intent === INTENTS.SUBMIT_DONE) {
          this.state = STATES.IDLE;
          return this._emit([{ type: ACTIONS.DISCARD }, notify(this.state)]);
        }
        if (intent === INTENTS.SUBMIT_FAILED) {
          this.lastError = detail || "transcription failed";
          this.state = STATES.ERROR;
          return this._emit([{ type: ACTIONS.DISCARD }, notify(this.state)]);
        }
        if (intent === INTENTS.CANCEL) {
          // Abort an in-flight upload and drop the take.
          this.state = STATES.IDLE;
          return this._emit([{ type: ACTIONS.DISCARD }, notify(this.state)]);
        }
        return this._emit([]);

      case STATES.ERROR:
        // Any tap (or cancel) clears the error and returns to idle. A fresh
        // Ctrl+Space then starts a new capture on the following press.
        if (intent === INTENTS.TOGGLE || intent === INTENTS.CANCEL) {
          this.lastError = null;
          this.state = STATES.IDLE;
          return this._emit([notify(this.state)]);
        }
        return this._emit([]);

      default:
        return this._emit([]);
    }
  }

  isActive() {
    return this.state !== STATES.IDLE && this.state !== STATES.ERROR;
  }

  _emit(actions) {
    return { state: this.state, actions };
  }
}
