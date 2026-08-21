# Tap-to-talk voice capture — exact manual smoke

Automated tests cover keyboard routing/state and the single `/submit → Ingress
STT → RelayBus → subscriber → pi` path without a real browser microphone. A
human must verify Chromium/Electron's device and OS-permission boundary.

## Prerequisites

Run Familiar with a live Herdr/pi subscriber and working `FAMILIAR_STT_URL`.
Use HTTPS or `http://localhost` in a browser. Have a microphone available.

## Browser

1. Focus the terminal and tap **F8** once. Confirm the themed pulsing
   `● recording` pill and “F8 to send, Esc to cancel” toast. Confirm no F8,
   NUL, `^@`, or other input appears in the TUI/PTY.
2. Speak, tap **F8** again. Confirm amber `● transcribing…`, then exactly one
   `🗣` user message in pi and a normal response.
3. Tap F8, speak, then **Escape**. Confirm immediate idle, microphone release,
   and no submitted message. Escape while idle must still reach the TUI.
4. Hold F8 briefly. Key repeat must not immediately stop/duplicate the take.
   A distinct second tap stops it. Recording auto-stops at 90 seconds.
5. Focus a real input, textarea, select, or contenteditable and press F8. The
   control retains the key; voice does not start. Focus the terminal again and
   verify unrelated printable/control keys still work.
6. Reload while recording: microphone releases and nothing submits. Deny mic
   permission and provoke an STT failure: verify themed red error UI and clean
   recovery. Recheck drag/drop, mouse, emoji, and zoom.

## Electron

Quit and relaunch Electron once after changing permission/input code, then run
`cd client && npm start` and repeat browser steps 1–6. Additionally confirm:

1. The OS mic prompt/grant succeeds for Familiar's configured origin.
2. F8 is not treated as a menu/global shortcut on macOS, Windows, or Linux;
   tap-on/tap-off and Escape behave exactly like the browser.
3. A page from any other origin and any video-bearing media request is denied.

This real device/OS interaction is not automated by the repository tests.
Electron's handler grants only `media` requests from the configured origin and
only when `mediaTypes` is empty or entirely audio; browser secure-context and
persisted-denial rules still apply.
