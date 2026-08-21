// Browser voice capture — the impure half of tap-to-talk. Owns getUserMedia,
// MediaRecorder, and the /submit fetch; delegates ALL logic to the pure
// VoiceStateMachine so the lifecycle is testable without a microphone.
//
// PATH (keypress → pi):
//   F8 (terminal.js) → VoiceCapture.toggle()
//     → getUserMedia → MediaRecorder (dynamic MIME)
//   F8 again → recorder.stop() → ondataavailable blob
//     → base64 → POST /submit  { type:"audio", id, seq:0, data, segments:1 }
//   server Ingress.transcribe (FAMILIAR_STT_URL) → dispatch → /relay
//     → subscriber RelayClient.sendParts → pi.sendUserMessage
//   → exactly one subscriber message lands in the live pi conversation.
//
// The server assembles a take from N segments; a browser take is a single
// segment (seq 0, segments 1), so the server transcribes and dispatches it the
// moment it arrives — no client-side chunk accounting needed.

import {
  VoiceStateMachine,
  STATES,
  INTENTS,
  ACTIONS,
} from "/app/voice-state.js";

// Prefer opus-in-webm/ogg (small, widely supported); fall back to whatever the
// UA will actually record. STT (whisper-family) reads all of these.
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
  "", // let the UA pick
];

function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of MIME_CANDIDATES) {
    if (m === "") return "";
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch (_) {
      /* isTypeSupported can throw on some UAs; keep scanning */
    }
  }
  return "";
}

// Guardrail so a stuck/looping recorder can never buffer unbounded audio in
// memory. ~90s of opus is well under a megabyte; the server /submit body also
// rides under the upload cap. A live recording is auto-stopped at this ceiling.
const MAX_RECORD_MS = 90_000;

export class VoiceCapture {
  // deps: { onState(state, detail), submitUrl }
  constructor(deps = {}) {
    this.sm = new VoiceStateMachine();
    this.onState = deps.onState || (() => {});
    this.submitUrl = deps.submitUrl || "/submit";

    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.mime = "";
    this.maxTimer = null;
    this.uploadAbort = null;
    // Monotonic take id — correlation id echoed back on the pi user message.
    this.takeSeq = Date.now() % 1_000_000;
  }

  // F8 tap. Fully synchronous entry; async work is kicked off by actions.
  toggle() {
    this._run(this.sm.dispatch(INTENTS.TOGGLE));
  }

  // Escape / unload. Idempotent.
  cancel() {
    this._run(this.sm.dispatch(INTENTS.CANCEL));
  }

  isActive() {
    return this.sm.isActive();
  }

  // Enact the ordered actions the state machine emitted.
  _run(result) {
    for (const action of result.actions) {
      switch (action.type) {
        case ACTIONS.REQUEST_MIC:
          this._requestMic();
          break;
        case ACTIONS.START_RECORDER:
          this._startRecorder();
          break;
        case ACTIONS.STOP_RECORDER:
          this._stopRecorder();
          break;
        case ACTIONS.UPLOAD:
          this._upload(action.take);
          break;
        case ACTIONS.DISCARD:
          this._discard();
          break;
        case ACTIONS.NOTIFY:
          this.onState(action.state, action.detail);
          break;
        default:
          break;
      }
    }
  }

  async _requestMic() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("getUserMedia unavailable (insecure context?)");
      }
      this.mime = pickMime();
      if (this.mime === null) throw new Error("MediaRecorder unsupported");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // A CANCEL may have raced in while the permission prompt was open; if we
      // are no longer requesting, drop the freshly-granted stream immediately.
      if (this.sm.state !== STATES.REQUESTING) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      this.stream = stream;
      const opts = this.mime ? { mimeType: this.mime } : {};
      this.recorder = new MediaRecorder(stream, opts);
      this.chunks = [];
      this.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };
      this.recorder.onstop = () => this._onRecorderStop();
      this.recorder.onerror = () =>
        this._run(this.sm.dispatch(INTENTS.MIC_DENIED, "recorder error"));
      this._run(this.sm.dispatch(INTENTS.MIC_READY));
    } catch (err) {
      const msg =
        err && err.name === "NotAllowedError"
          ? "microphone permission denied"
          : (err && (err.message || String(err))) || "microphone error";
      this._run(this.sm.dispatch(INTENTS.MIC_DENIED, msg));
    }
  }

  _startRecorder() {
    try {
      // Single blob on stop (timeslice omitted) keeps memory tiny for short
      // takes; the MAX_RECORD_MS ceiling bounds a runaway.
      this.recorder.start();
      this.maxTimer = setTimeout(() => {
        // Auto-stop as if the user tapped off.
        if (this.sm.state === STATES.RECORDING) this.toggle();
      }, MAX_RECORD_MS);
    } catch (err) {
      this._run(this.sm.dispatch(INTENTS.MIC_DENIED, "recorder start failed"));
    }
  }

  _stopRecorder() {
    this._clearMaxTimer();
    try {
      if (this.recorder && this.recorder.state !== "inactive") {
        this.recorder.stop(); // → onstop → _onRecorderStop
      } else {
        this._onRecorderStop();
      }
    } catch (_) {
      this._onRecorderStop();
    }
  }

  _onRecorderStop() {
    const blob = new Blob(this.chunks, this.mime ? { type: this.mime } : {});
    // Stop the mic tracks now that capture is flushed (release the indicator).
    this._stopTracks();
    if (!blob.size) {
      this._run(this.sm.dispatch(INTENTS.CAPTURE_STOPPED, { empty: true }));
      return;
    }
    this._run(
      this.sm.dispatch(INTENTS.CAPTURE_STOPPED, { blob, empty: false }),
    );
  }

  async _upload(take) {
    const id = ++this.takeSeq;
    this.uploadAbort = new AbortController();
    try {
      const b64 = await blobToBase64(take.blob);
      // Reuse the EXISTING audio ingress: one segment, whole take.
      const body = JSON.stringify({
        type: "audio",
        id,
        seq: 0,
        data: b64,
        segments: 1,
      });
      const res = await fetch(this.submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: this.uploadAbort.signal,
      });
      // 200 = accepted+dispatched; 409 = server still missing a segment (should
      // not happen for a single-segment take) — treat non-2xx as failure.
      if (!res.ok) throw new Error(`submit ${res.status}`);
      this._run(this.sm.dispatch(INTENTS.SUBMIT_DONE));
    } catch (err) {
      if (err && err.name === "AbortError") return; // cancelled; already idle
      const msg = (err && (err.message || String(err))) || "submit failed";
      this._run(this.sm.dispatch(INTENTS.SUBMIT_FAILED, msg));
    } finally {
      this.uploadAbort = null;
    }
  }

  _discard() {
    this._clearMaxTimer();
    if (this.uploadAbort) {
      try {
        this.uploadAbort.abort();
      } catch (_) {
        /* ignore */
      }
      this.uploadAbort = null;
    }
    try {
      if (this.recorder && this.recorder.state !== "inactive") {
        this.recorder.onstop = null; // suppress the discard-time stop handler
        this.recorder.stop();
      }
    } catch (_) {
      /* ignore */
    }
    this.recorder = null;
    this.chunks = [];
    this._stopTracks();
  }

  _stopTracks() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        try {
          t.stop();
        } catch (_) {
          /* ignore */
        }
      }
      this.stream = null;
    }
  }

  _clearMaxTimer() {
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
  }
}

// Blob → base64 (no data: prefix) for the /submit audio payload. Chunked read
// avoids the giant call-stack of String.fromCharCode(...bigArray).
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.onload = () => {
      const url = String(reader.result || "");
      const comma = url.indexOf(",");
      resolve(comma >= 0 ? url.slice(comma + 1) : "");
    };
    reader.readAsDataURL(blob);
  });
}
