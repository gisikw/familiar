# Tap-to-talk voice capture — manual smoke checklist

The automated tests (`server/web/voice-state.test.js`,
`server/test/voice-ingress.test.ts`) cover the state machine and the
`/submit → /relay` protocol with **no microphone**. This checklist covers the
last mile that only a human + a real mic + a live pi session can verify.

## Prerequisites

- A running familiar server (`cd server && npm start`) fronted by a live herdr
  session, with `FAMILIAR_STT_URL` pointing at a working STT endpoint (the
  `.#stt` dev shell provides `transcribe-cpp`).
- The subscriber extension loaded in pi (so `/relay` has a subscriber). Confirm:
  `curl -s localhost:1692/health` returns `{ok:true,...}` and the pi TUI is up.
- A microphone. In the **browser**, open over `https://` or `http://localhost`
  (getUserMedia requires a secure context; `localhost` counts). In the
  **Electron shell**, the served page loads over the resolved base URL and the
  main process grants the `media` permission for that origin automatically.

## Browser (canonical server page at `/` or `/terminal`)

1. **Start capture.** Focus the terminal, press **Ctrl+Space**.
   - [ ] The keystroke does NOT reach the shell (no NUL/`^@`, no space typed).
   - [ ] The top-center pill shows `● recording` (accent color, soft pulse).
   - [ ] A toast reads "recording — Ctrl+Space to send, Esc to cancel".
   - [ ] First run: the browser mic-permission prompt appears; granting it
         proceeds to `recording`. Denying it → red `● …permission denied` pill
         + toast, then idle.
2. **Speak** a short sentence.
3. **Stop + submit.** Press **Ctrl+Space** again.
   - [ ] Pill switches to amber `● transcribing…`.
   - [ ] Within a second or two the pill disappears (idle).
   - [ ] Exactly ONE new user message appears in the pi conversation, prefixed
         `🗣`, containing your transcript. (Not zero, not two.)
   - [ ] pi begins responding to it as a normal steer.
4. **Cancel path.** Ctrl+Space to start, speak, then press **Escape**.
   - [ ] Pill vanishes immediately; NO message is submitted to pi.
   - [ ] The mic indicator in the browser tab/OS turns off (tracks released).
5. **Double-tap guard.** Mash Ctrl+Space rapidly several times.
   - [ ] No duplicate submissions; at most one message per complete
         start→stop cycle. No stuck `recording` state.
6. **Focus guard.** If any browser `<input>`/`<textarea>` ever holds focus
   (none in the stock page, but verify if you add one), Ctrl+Space is NOT
   claimed and the input receives it.
7. **Unload safety.** Start recording, then reload the page (Cmd/Ctrl+R) or
   close the tab mid-recording.
   - [ ] The mic indicator turns off; no orphaned recording; no submission.
8. **Error recovery.** Temporarily point `FAMILIAR_STT_URL` at a dead port,
   record + stop.
   - [ ] Red error pill + toast (`submit 5xx` / transcription failed); returns
         to idle. Next Ctrl+Space clears the error and starts fresh.
9. **Regression — existing surfaces untouched:**
   - [ ] Drag-drop a screenshot onto the terminal still uploads + notifies.
   - [ ] Mouse reporting in a TUI (e.g. scroll/click in a pager) still works.
   - [ ] Emoji completion (`:smile`) and Cmd/Ctrl +/- zoom still work.
   - [ ] `?probe=1` latency probe still reports p50/p95.

## Electron dumb shell (`client/`)

Run `cd client && npm start` (it loads the same served page).

1. [ ] First Ctrl+Space triggers the OS mic-permission dialog once (macOS: the
       system prompt; the main process' `setPermissionRequestHandler` grants
       audio for our origin). Subsequent runs do not re-prompt.
2. [ ] The full record → stop → 🗣 message flow works identically to the browser.
3. [ ] Ctrl+Space is NOT swallowed by any Electron global/local shortcut — the
       shell registers no `globalShortcut`, and `before-input-event` only
       handles the zoom mod-chords, so Ctrl+Space passes through to the page.
4. [ ] Escape cancels; reload (Cmd/Ctrl+R) mid-recording releases the mic.
5. [ ] Drag-drop, mouse, zoom, and the offline/reconnect page still behave.

## Permission caveats (document, don't fight)

- **Secure context required.** `navigator.mediaDevices.getUserMedia` is
  undefined on plain `http://` non-localhost origins. When familiar is fronted
  by nginx at `familiar.gisi.network`, that origin MUST be https. The client
  surfaces "getUserMedia unavailable (insecure context?)" if it is not.
- **One-time browser grant.** The browser remembers the mic grant per origin;
  a denied grant sticks until the user clears it in site settings. The error
  pill tells them what happened; it cannot re-prompt on its own.
- **Electron origin scoping.** The permission handler only grants `media` for
  the resolved base origin; any other origin is denied.
