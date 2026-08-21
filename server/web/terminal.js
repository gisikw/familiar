import { Restty, createWebSocketPtyTransport, getBuiltinTheme } from "/vendor/restty.esm.js";
import { DecsetTracker, encodeMouse, domButtonToCode } from "/app/mouse.js";
import { EmojiCompleter, loadEmoji } from "/app/emoji.js";
import { VoiceCapture } from "/app/voice.js";
import { STATES as VOICE_STATES } from "/app/voice-state.js";
import { installVoiceKeyRouter, VOICE_KEY_LABEL } from "/app/voice-key-routing.js";

// Browser terminal for the familiar server. Unlike the Electron client (which
// bridges restty to node-pty over IPC), here restty talks to the server's /pty
// WebSocket endpoint, which bridges to a node-pty child attached to the running
// herdr session.
//
// WHY A CUSTOM TRANSPORT (mouse root-cause fix): the app-mouse layer needs two
// things from the terminal that restty 0.2.6 does NOT expose as public methods:
//   (a) the raw pty OUTPUT stream, to watch for DECSET 1000/1002/1003/1006 mode
//       toggles (so we know when the remote app wants mouse reports); and
//   (b) the live grid geometry (cols/rows), to map pointer px → cell.
// The Electron renderer gets both by owning a custom `ptyTransport` (it wraps
// IPC onData + tracks resize). The previous served version instead used
// restty's BUILT-IN ws transport and tried `restty.onOutput(...)` /
// `restty.getGridSize()` — neither exists on the Restty class, so those calls
// silently no-op'd: `decset` was never fed, `isActive()` was always false, and
// every pointer handler early-returned → mouse totally dead. Fix: mirror the
// Electron pattern by wrapping restty's own WebSocket transport so we tap the
// same onData/resize the runtime uses.

// Shared app-mouse tracker: fed by pty output, read by the mouse layer.
const decset = new DecsetTracker();
let gridCols = 80;
let gridRows = 24;

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/pty`;
}

// ---------------------------------------------------------------------------
// Latency probe. `?probe=1` auto-runs; window.__familiarProbe(n) runs on
// demand from the dev console. Sends a unique marker through the SAME input
// path a keystroke takes and measures wall time until that marker's bytes come
// back on the pty OUTPUT stream (keystroke → echo). Reports p50/p95 over N.
// The output tap lives in the transport wrapper below (outputTaps).
// ---------------------------------------------------------------------------
const outputTaps = new Set();
function feedOutput(data) {
  decset.feed(data);
  for (const tap of outputTaps) {
    try { tap(data); } catch (_) { /* ignore */ }
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runProbe(samples = 20) {
  if (!transport || !transport.isConnected()) {
    console.warn("[probe] transport not connected");
    return null;
  }
  const times = [];
  for (let i = 0; i < samples; i++) {
    const marker = `\x1bP+q${i}_${Math.random().toString(36).slice(2, 8)}\x1b\\`;
    // Fallback marker: a printable, unlikely token echoed by a shell. We watch
    // for the printable core so both echo shells and redrawing TUIs match.
    const token = `zfprobe${i}${Math.random().toString(36).slice(2, 6)}`;
    const dt = await new Promise((resolve) => {
      const t0 = performance.now();
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        outputTaps.delete(tap);
        resolve(NaN);
      }, 2000);
      const tap = (data) => {
        if (settled) return;
        if (data.includes(token)) {
          settled = true;
          clearTimeout(timeout);
          outputTaps.delete(tap);
          resolve(performance.now() - t0);
        }
      };
      outputTaps.add(tap);
      // Send the printable token through the input path. Suffix a NUL-ish
      // no-op is avoided; we just type the token (no newline → no command run).
      writePty(token);
      // Immediately erase it so the probe leaves the line as it found it.
      // Backspaces are sent AFTER we start listening; they don't affect the
      // token-appearance measurement (the token echoes before the erase).
      writePty("\b".repeat(token.length) + " ".repeat(token.length) + "\b".repeat(token.length));
      void marker;
    });
    if (!Number.isNaN(dt)) times.push(dt);
    await new Promise((r) => setTimeout(r, 40));
  }
  times.sort((a, b) => a - b);
  const result = {
    samples: times.length,
    p50: +percentile(times, 50).toFixed(2),
    p95: +percentile(times, 95).toFixed(2),
    min: +(times[0] ?? NaN).toFixed(2),
    max: +(times[times.length - 1] ?? NaN).toFixed(2),
  };
  console.log("[probe] keystroke→echo ms", result);
  toast(`probe p50=${result.p50}ms p95=${result.p95}ms (n=${result.samples})`);
  return result;
}
window.__familiarProbe = runProbe;

// ---------------------------------------------------------------------------
// Custom PTY transport: wrap restty's built-in WebSocket transport so we can
// (a) tap onData for DECSET tracking + the latency probe, and (b) track grid
// geometry from resize. Mirrors client/src/renderer's IPC transport shape.
// ---------------------------------------------------------------------------
function createTappedWsTransport() {
  const inner = createWebSocketPtyTransport();
  return {
    connect(options) {
      const userCbs = options.callbacks || {};
      const wrapped = {
        ...userCbs,
        onData: (data) => {
          feedOutput(data);
          userCbs.onData && userCbs.onData(data);
        },
      };
      if (options.cols) gridCols = options.cols;
      if (options.rows) gridRows = options.rows;
      return inner.connect({ ...options, callbacks: wrapped });
    },
    disconnect() { return inner.disconnect(); },
    sendInput(data) { return inner.sendInput(data); },
    resize(cols, rows, meta) {
      if (cols) gridCols = cols;
      if (rows) gridRows = rows;
      return inner.resize(cols, rows, meta);
    },
    isConnected() { return inner.isConnected(); },
    destroy() { return inner.destroy && inner.destroy(); },
  };
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
function toast(message) {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span class="icon">●</span>${escapeHtml(message)}`;
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------------------
// Boot restty
// ---------------------------------------------------------------------------
const root = document.getElementById("terminal");
const DEFAULT_FONT_SIZE = 14;
let fontSize = DEFAULT_FONT_SIZE;
let restty = null;
let voice = null;
const transport = createTappedWsTransport();

// Reserve voice input before boot constructs Restty. Restty focuses a hidden
// `.restty-pane-ime-input` textarea, then forwards window keydown events to its
// encoder. The old generic INPUT/TEXTAREA focus guard therefore returned before
// toggle(), after which restty/Herdr consumed Ctrl+Space (normally encoded as
// NUL). F8 avoids OS/browser Ctrl+Space collisions too. The router recognizes
// restty's IME sink as terminal focus while preserving the guard for real form
// controls; capture + stopImmediatePropagation prevents any PTY forwarding.
installVoiceKeyRouter(window, {
  getVoice: () => voice,
  getActiveElement: () => document.activeElement,
  isTerminalInput: (element) => element?.classList?.contains("restty-pane-ime-input") === true,
});

async function loadFont(name) {
  const res = await fetch(`/fonts/${name}`);
  if (!res.ok) throw new Error(`font ${name} ${res.status}`);
  return await res.arrayBuffer();
}

async function boot() {
  // Font fallback array — restty renders via a GPU glyph atlas (no DOM CSS
  // fallback), so we hand it the chain explicitly. ProggyClean NF is primary
  // (Nerd glyphs); JetBrains Mono is the text fallback; the OpenMoji entry
  // (name MUST contain "OpenMoji") is classified by restty as a color-emoji
  // cmap provider → platform color emoji via its canvas stack.
  let fonts;
  try {
    const [proggy, regular, bold, italic, openmoji] = await Promise.all([
      loadFont("ProggyCleanNerdFontMono-Regular.ttf"),
      loadFont("JetBrainsMono-Regular.ttf"),
      loadFont("JetBrainsMono-Bold.ttf"),
      loadFont("JetBrainsMono-Italic.ttf"),
      loadFont("OpenMoji-black-glyf.ttf"),
    ]);
    fonts = [
      { data: proggy },
      { data: regular },
      { data: bold, weight: 700 },
      { data: italic, style: "italic" },
      { data: openmoji, name: "OpenMoji" },
    ];
  } catch (err) {
    console.error("font load failed, using restty defaults", err);
  }

  // Themed canvas background. restty's default pane canvas is pure BLACK; the
  // Electron client's window paints the theme bg behind it, so a served page
  // (no such window bg) would look full-black. We fetch the server-resolved
  // theme (/theme.json — a GhosttyTheme built from FAMILIAR_THEME_* at boot):
  // background/foreground/cursor/selection + the ANSI-16 palette all track the
  // unified Familiar theme, so browser panes match the herdr/pi/Electron look
  // and change on cold restart with no asset rebuild. Falls back to the
  // built-in Catppuccin Mocha (then restty default) if the endpoint is down.
  let theme;
  try {
    const res = await fetch("/theme.json", { cache: "no-cache" });
    if (res.ok) theme = await res.json();
  } catch (_) { /* fall through */ }
  if (!theme) {
    try { theme = getBuiltinTheme("Catppuccin Mocha"); } catch (_) { /* restty default */ }
  }

  restty = new Restty({
    root,
    services: {
      // Our tapped transport supplies onData (DECSET + probe) and grid geometry.
      ptyTransport: transport,
    },
    terminal: {
      renderer: "auto",
      fontSize: DEFAULT_FONT_SIZE,
      autoResize: true,
      ...(theme ? { theme } : {}),
      ...(fonts ? { fonts } : {}),
    },
  });

  // Kick the connection — url flows through to transport.connect(options.url).
  restty.connectPty(wsUrl());
  restty.focus();

  // We own app-mouse; disable restty's own mouse reporting so clicks aren't
  // double-encoded. Selection still works when tracking is off.
  try { restty.setMouseMode("off"); } catch (_) { /* older restty */ }

  wireFontZoom();
  wireAppMouse();
  wireEmoji();
  wireVoice();

  try { window.__familiarBackend = restty.getBackend(); } catch (_) { window.__familiarBackend = "unknown"; }

  if (new URLSearchParams(location.search).get("probe") === "1") {
    // Give the attach a moment to settle (herdr draws its UI), then probe.
    setTimeout(() => runProbe(30), 1500);
  }
}

// ---------------------------------------------------------------------------
// Font zoom (Cmd/Ctrl +/-/0 in the browser).
// ---------------------------------------------------------------------------
function wireFontZoom() {
  window.addEventListener("keydown", (e) => {
    const mod = navigator.platform.startsWith("Mac") ? e.metaKey : e.ctrlKey;
    if (!mod) return;
    let action = null;
    if (e.key === "=" || e.key === "+") action = "in";
    else if (e.key === "-" || e.key === "_") action = "out";
    else if (e.key === "0") action = "reset";
    if (!action) return;
    if (action === "in") fontSize = Math.min(48, fontSize + 1);
    else if (action === "out") fontSize = Math.max(6, fontSize - 1);
    else fontSize = DEFAULT_FONT_SIZE;
    try { restty.setFontSize(fontSize); restty.updateSize(true); } catch (_) { /* ignore */ }
    e.preventDefault();
  }, true);
}

// ---------------------------------------------------------------------------
// App-mouse forwarding. Translate pointer events over the terminal into
// SGR/X10 mouse reports when the remote app requests tracking (DECSET).
// ---------------------------------------------------------------------------
function pointerToCell(ev) {
  const rect = root.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const cellW = rect.width / Math.max(1, gridCols);
  const cellH = rect.height / Math.max(1, gridRows);
  let col = Math.floor(x / Math.max(1, cellW)) + 1;
  let row = Math.floor(y / Math.max(1, cellH)) + 1;
  col = Math.min(Math.max(1, col), gridCols);
  row = Math.min(Math.max(1, row), gridRows);
  return { col, row };
}

function writePty(seq) {
  try { transport.sendInput(seq); } catch (_) { /* ignore */ }
}

function wireAppMouse() {
  let pressedButton = null;
  const send = (kind, ev) => {
    if (!decset.isActive()) return false;
    const { col, row } = pointerToCell(ev);
    const button = kind === "wheel" ? (ev.deltaY < 0 ? 64 : 65) : domButtonToCode(ev.button);
    const seq = encodeMouse(kind, {
      format: decset.format(), button, col, row,
      mods: { shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey },
      motion: decset.motion(),
    });
    writePty(seq);
    return true;
  };

  root.addEventListener("pointerdown", (ev) => {
    if (!decset.isActive()) return;
    pressedButton = ev.button;
    if (send("down", ev)) { ev.preventDefault(); ev.stopPropagation(); root.setPointerCapture && root.setPointerCapture(ev.pointerId); }
  }, true);
  root.addEventListener("pointerup", (ev) => {
    if (!decset.isActive()) return;
    pressedButton = null;
    if (send("up", ev)) { ev.preventDefault(); ev.stopPropagation(); }
  }, true);
  root.addEventListener("pointermove", (ev) => {
    if (!decset.isActive()) return;
    const motion = decset.motion();
    if (motion === "none") return;
    if (motion === "drag" && pressedButton === null) return;
    const btn = pressedButton === null ? 3 : domButtonToCode(pressedButton);
    const { col, row } = pointerToCell(ev);
    const seq = encodeMouse("move", {
      format: decset.format(), button: btn, col, row,
      mods: { shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey }, motion,
    });
    writePty(seq); ev.preventDefault(); ev.stopPropagation();
  }, true);
  root.addEventListener("wheel", (ev) => {
    if (!decset.isActive()) return;
    if (send("wheel", ev)) { ev.preventDefault(); ev.stopPropagation(); }
  }, { capture: true, passive: false });
}

// ---------------------------------------------------------------------------
// Emoji completion. Intercept keydown at capture phase, before restty forwards
// to the pty.
// ---------------------------------------------------------------------------
let emojiCompleter = null;
async function wireEmoji() {
  try { await loadEmoji(); } catch (err) { console.error("emoji load failed", err); return; }
  emojiCompleter = new EmojiCompleter({
    writeToPty: (s) => writePty(s),
    getCursorRect: () => {
      const r = root.getBoundingClientRect();
      return { left: r.left + 8, top: r.bottom - 40, bottom: r.bottom - 8 };
    },
  });
  window.addEventListener("keydown", (e) => {
    const mod = navigator.platform.startsWith("Mac") ? e.metaKey : e.ctrlKey;
    if (mod && (e.key === "e" || e.key === "E")) {
      const on = emojiCompleter.toggle();
      toast(on ? "emoji completion on" : "emoji completion off");
      e.preventDefault(); e.stopPropagation(); return;
    }
    const consumed = emojiCompleter.handleKeydown(e);
    if (consumed) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

boot();

// ---------------------------------------------------------------------------
// Tap-to-talk voice capture. F8 starts recording; a second F8 stops,
// transcribes (server STT), and submits ONE subscriber message into the live
// pi conversation via the existing /submit audio ingress. Escape cancels.
// Keyboard reservation is installed above, before Restty is constructed.
// ---------------------------------------------------------------------------
function wireVoice() {
  const indicator = document.getElementById("voice-indicator");
  const setIndicator = (state, detail) => {
    if (!indicator) return;
    indicator.classList.remove("recording", "finalizing", "error");
    let label = "";
    if (state === VOICE_STATES.REQUESTING) { label = "mic…"; indicator.classList.add("recording"); }
    else if (state === VOICE_STATES.RECORDING) { label = "recording"; indicator.classList.add("recording"); }
    else if (state === VOICE_STATES.FINALIZING) { label = "transcribing…"; indicator.classList.add("finalizing"); }
    else if (state === VOICE_STATES.ERROR) { label = detail || "voice error"; indicator.classList.add("error"); }
    indicator.textContent = label ? `● ${label}` : "";
    indicator.classList.toggle("show", !!label);
  };

  voice = new VoiceCapture({
    submitUrl: "/submit",
    onState: (state, detail) => {
      setIndicator(state, detail);
      if (state === VOICE_STATES.ERROR) toast(detail || "voice error");
      if (state === VOICE_STATES.RECORDING) toast(`recording — ${VOICE_KEY_LABEL} to send, Esc to cancel`);
    },
  });

  // No recording may survive an unload or a lost connection.
  window.addEventListener("beforeunload", () => { try { voice.cancel(); } catch (_) { /* ignore */ } });
  window.addEventListener("pagehide", () => { try { voice.cancel(); } catch (_) { /* ignore */ } });
}

// ---------------------------------------------------------------------------
// Drag-and-drop capture. THE point (mirrors the Electron renderer): prevent the
// default so the terminal never sees a file:// path paste; capture the bytes;
// POST them to /upload (same origin) so they land on the server host and the
// running agent is told. Attach on window with capture=true so nothing
// downstream (the restty canvas) ever sees the drop.
// ---------------------------------------------------------------------------
function wireDrop() {
  const dropHint = document.getElementById("drop-hint");
  let dragDepth = 0;
  const showHint = (on) => dropHint && dropHint.classList.toggle("active", on);

  window.addEventListener("dragenter", (e) => {
    e.preventDefault(); e.stopPropagation();
    dragDepth++; showHint(true);
  }, true);

  window.addEventListener("dragover", (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }, true);

  window.addEventListener("dragleave", (e) => {
    e.preventDefault(); e.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showHint(false);
  }, true);

  window.addEventListener("drop", async (e) => {
    // CRITICAL: stop the browser/terminal default so no path text is injected.
    e.preventDefault(); e.stopPropagation();
    dragDepth = 0; showHint(false);

    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length === 0) return;

    for (const file of files) {
      try {
        const form = new FormData();
        form.append("file", file, file.name);
        const res = await fetch("/upload", { method: "POST", body: form });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
          toast(`drop failed: ${escapeHtml(json.error || res.status)}`);
          continue;
        }
        const short = String(json.path || file.name).split("/").pop();
        toast(json.notified ? `captured ${short}` : `saved ${short} (agent not notified)`);
      } catch (err) {
        toast(`drop failed: ${file.name}`);
        console.error("drop upload failed", err);
      }
    }
    if (restty) restty.focus();
  }, true);
}

wireDrop();
