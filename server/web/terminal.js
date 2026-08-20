import { Restty } from "/vendor/restty.esm.js";
import { DecsetTracker, encodeMouse, domButtonToCode } from "/app/mouse.js";
import { EmojiCompleter, loadEmoji } from "/app/emoji.js";

// Browser terminal for the familiar server. Unlike the Electron client (which
// bridges restty to node-pty over IPC), here we use restty's BUILT-IN
// WebSocket PTY transport pointed at the server's /pty endpoint, which bridges
// to a node-pty child attached to the running herdr session.
//
// Ported niceties from client/src/renderer: in-memory font array (ProggyClean
// NF primary + JetBrains Mono + OpenMoji cmap entry), SGR mouse synthesis
// (mouse.js), emoji completer (emoji.js).

// Shared app-mouse tracker: fed by pty output, read by the mouse layer.
const decset = new DecsetTracker();
let gridCols = 80;
let gridRows = 24;

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/pty`;
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

  restty = new Restty({
    root,
    terminal: {
      renderer: "auto",
      fontSize: DEFAULT_FONT_SIZE,
      autoResize: true,
      ...(fonts ? { fonts } : {}),
    },
  });

  // Native WebSocket PTY transport → server /pty → node-pty herdr attach.
  restty.connectPty(wsUrl());
  restty.focus();

  // We own app-mouse; disable restty's own mouse reporting so clicks aren't
  // double-encoded. Selection still works.
  try { restty.setMouseMode("off"); } catch (_) { /* older restty */ }

  // Keep grid geometry in sync for the mouse layer. autoResize drives the
  // transport resize; we mirror the numbers by polling restty's reported size.
  syncGrid();

  wireFontZoom();
  wireAppMouse();
  wireEmoji();

  try { window.__familiarBackend = restty.getBackend(); } catch (_) { window.__familiarBackend = "unknown"; }
}

function syncGrid() {
  const tick = () => {
    try {
      const size = restty.getGridSize?.() || restty.gridSize;
      if (size && size.cols && size.rows) { gridCols = size.cols; gridRows = size.rows; }
    } catch (_) { /* ignore */ }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
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
  try { restty.sendInput ? restty.sendInput(seq) : restty.write(seq); } catch (_) { /* ignore */ }
}

function wireAppMouse() {
  // restty's WS transport calls onData through the surface; we tap output for
  // DECSET toggles by wrapping getBackend's data path is not exposed, so we
  // instead listen on restty's output hook if present, else fall back to the
  // surface's onData event.
  try {
    restty.onOutput?.((data) => decset.feed(data));
  } catch (_) { /* ignore */ }

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
