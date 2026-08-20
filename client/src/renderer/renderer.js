import { Restty } from "./vendor/restty.esm.js";
import { DecsetTracker, encodeMouse, domButtonToCode } from "./mouse.js";
import { EmojiCompleter, loadEmoji } from "./emoji.js";

const { familiar } = window;

// Shared app-mouse tracker: fed by pty output, read by the mouse layer.
const decset = new DecsetTracker();
// Last known grid geometry (kept in sync by the transport.resize below).
let gridCols = 80;
let gridRows = 24;

// ---------------------------------------------------------------------------
// Custom PtyTransport: restty is renderer-side only and normally talks to a
// WebSocket PTY server. We instead bridge its transport interface straight to
// our Electron IPC channel (preload -> main -> node-pty). No WS server needed.
//
// Backpressure note: restty pushes input via sendInput(); we forward each chunk
// over IPC immediately. node-pty writes are buffered by libuv; for a single
// interactive shell this is ample. Output backpressure is handled the other
// way: main streams 'pty:data' and restty's WASM core queues/coalesces frames
// for the renderer, so a burst (e.g. `cat bigfile`) does not block the UI.
// ---------------------------------------------------------------------------
function createIpcPtyTransport() {
  let connected = false;
  let cbs = null;
  let offData = null;
  let offExit = null;
  let offStatus = null;

  return {
    connect(options) {
      cbs = options.callbacks || {};
      offData = familiar.pty.onData((data) => {
        // Watch output for app mouse-mode toggles (DECSET 1000/1002/1003/1006).
        decset.feed(data);
        cbs.onData && cbs.onData(data);
      });
      offExit = familiar.pty.onExit(
        (code) => cbs.onExit && cbs.onExit(code | 0)
      );
      offStatus = familiar.pty.onStatus(
        (s) => cbs.onStatus && cbs.onStatus(s.shell || "shell")
      );
      familiar.pty.start({ cols: options.cols || 80, rows: options.rows || 24 });
      gridCols = options.cols || 80;
      gridRows = options.rows || 24;
      connected = true;
      // restty expects an onConnect ping to flip its lifecycle to connected.
      if (cbs.onConnect) cbs.onConnect();
    },
    disconnect() {
      connected = false;
      if (cbs && cbs.onDisconnect) cbs.onDisconnect();
    },
    sendInput(data) {
      if (!connected) return false;
      familiar.pty.write(data);
      return true;
    },
    resize(cols, rows) {
      if (!connected) return false;
      gridCols = cols;
      gridRows = rows;
      familiar.pty.resize({ cols, rows });
      return true;
    },
    isConnected() {
      return connected;
    },
    destroy() {
      offData && offData();
      offExit && offExit();
      offStatus && offStatus();
      connected = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
function toast(message) {
  const stack = document.getElementById("toast-stack");
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span class="icon">●</span>${escapeHtml(message)}`;
  stack.appendChild(el);
  // force reflow then show
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]
  );
}

// ---------------------------------------------------------------------------
// Fatal diagnostic panel. If the shell fails to spawn, replace the black
// terminal with a readable report instead of leaving a dead window. This is
// the single most important recovery path: the next launch tells us exactly
// what's wrong even if a fix attempt missed.
// ---------------------------------------------------------------------------
function showFatal(info) {
  const root = document.getElementById("terminal");
  if (!root) return;
  const d = (info && info.diagnostics) || {};
  const v = (info && info.versions) || {};
  const helper = Array.isArray(d.spawnHelper)
    ? d.spawnHelper
        .map((h) =>
          h.error
            ? `  ${h.path} — ERROR ${h.error}`
            : `  ${h.path} — mode ${((h.mode || 0) >>> 0).toString(8)}`
        )
        .join("\n")
    : "  (none found)";

  const lines = [
    info && info.message ? info.message : "The shell failed to start.",
    info && info.cause ? `cause: ${info.cause}` : null,
    "",
    `shell:        ${d.shell || "?"}  (exists: ${d.shellExists})`,
    `cwd:          ${d.cwd || "?"}  (exists: ${d.cwdExists})`,
    `platform:     ${d.platform || "?"} ${d.arch || ""}`,
    `electron:     ${v.electron || "?"}`,
    `node:         ${v.node || "?"}   modules(ABI): ${v.modules || "?"}`,
    `PATH head:    ${(d.pathHead || []).join(":") || "?"}`,
    "",
    "spawn-helper (must be executable, mode 755):",
    helper,
    "",
    "Most likely fixes:",
    "  1. Make the pty helper executable:  npm run fix-pty",
    "  2. Ensure your shell exists / $SHELL is valid.",
    "  3. Re-install outside nix-shell if PATH points into /nix/store.",
  ].filter((x) => x !== null);

  root.innerHTML =
    '<pre class="fatal">' + escapeHtml(lines.join("\n")) + "</pre>";
}

familiar.pty.onFatal(showFatal);

// ---------------------------------------------------------------------------
// Boot restty
// ---------------------------------------------------------------------------
const root = document.getElementById("terminal");
const transport = createIpcPtyTransport();
let restty = null;

// Font sizing state for Cmd/Ctrl +/-/0 zoom.
const DEFAULT_FONT_SIZE = 14;
let fontSize = DEFAULT_FONT_SIZE;

async function boot() {
  // Load bundled font bytes via IPC (CSP blocks fetch() of file:// fonts).
  // Pass as in-memory buffers so restty never touches the network.
  // ProggyClean Nerd Font is the PRIMARY face (Nerd glyphs for Kevin's
  // prompt/statusline); JetBrains Mono stays as the fallback chain.
  //
  // WHY THE EMOJI FONT IS HERE (root-cause fix): restty renders via a
  // canvas/WebGL(GPU) glyph atlas, NOT the DOM, so there is no CSS
  // font-family chain doing per-glyph fallback for us. restty does its own
  // per-glyph fallback by walking THIS `fonts` array: for an emoji codepoint
  // (e.g. U+1FAB6 FEATHER) it looks for an entry it classifies as a color
  // emoji font (label matches /apple color emoji|noto color emoji|openmoji|
  // .../). If none is present it falls back to index 0 (ProggyClean), which
  // has NO emoji glyphs -> blank/tofu. By passing our OWN fonts array we
  // *replaced* restty's built-in default fallback chain (which included
  // emoji + symbol fonts), so emoji stopped rendering entirely.
  //
  // OpenMoji (black-glyf) is bundled purely as a CMAP PROVIDER: restty's
  // color-glyph path rasterizes emoji through a canvas 2D CSS stack
  // ("Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",...), and for an
  // OpenMoji-labelled entry it deliberately uses ONLY that platform stack
  // (it strips the OpenMoji family). So the actual pixels come from the OS
  // color emoji font (Apple Color Emoji on macOS, Noto Color Emoji on Linux);
  // OpenMoji just supplies the glyph-id mapping and is a small (~1.5MB) black
  // font rather than a huge (~10MB+) color file. ProggyClean already carries
  // the full Nerd Font symbol ranges, so no separate symbol fallback needed.
  let fonts;
  try {
    const [proggy, regular, bold, italic, openmoji] = await Promise.all([
      familiar.readFont("ProggyCleanNerdFontMono-Regular.ttf"),
      familiar.readFont("JetBrainsMono-Regular.ttf"),
      familiar.readFont("JetBrainsMono-Bold.ttf"),
      familiar.readFont("JetBrainsMono-Italic.ttf"),
      familiar.readFont("OpenMoji-black-glyf.ttf"),
    ]);
    fonts = [
      { data: proggy }, // primary: Nerd Font glyphs (full symbol coverage)
      { data: regular }, // text fallback faces
      { data: bold, weight: 700 },
      { data: italic, style: "italic" },
      // Emoji cmap provider -> platform color emoji via restty's canvas stack.
      // `name` MUST contain "OpenMoji" so restty classifies it as color emoji.
      { data: openmoji, name: "OpenMoji" },
    ];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("font load failed, using restty defaults", err);
  }

  restty = new Restty({
    root,
    services: {
      ptyTransport: transport,
    },
    terminal: {
      renderer: "auto", // WebGPU, WebGL2 fallback
      fontSize: DEFAULT_FONT_SIZE,
      autoResize: true, // restty syncs cols/rows -> transport.resize on layout
      ...(fonts ? { fonts } : {}),
    },
  });

  // Kick the connection. URL is unused by our transport but the API wants a call.
  restty.connectPty("ipc://familiar");
  restty.focus();

  // We own app-mouse; disable restty's own mouse reporting so clicks aren't
  // double-encoded. Selection (shift-drag / no-app-mouse drag) still works.
  try {
    restty.setMouseMode("off");
  } catch (_) {
    /* older restty without setMouseMode */
  }

  wireFontZoom();
  wireAppMouse();
  wireEmoji();

  // Expose selected renderer backend for diagnostics/self-test.
  try {
    window.__familiarBackend = restty.getBackend();
  } catch (_) {
    window.__familiarBackend = "unknown";
  }
}

// ---------------------------------------------------------------------------
// Font zoom. main sends "zoom:font" (in|out|reset) for Cmd/Ctrl +/-/0. restty
// changes the font size; autoResize recomputes rows/cols and calls
// transport.resize -> pty. Those chords never reach the pty (swallowed in main).
// ---------------------------------------------------------------------------
function wireFontZoom() {
  familiar.onZoomFont((action) => {
    if (action === "in") fontSize = Math.min(48, fontSize + 1);
    else if (action === "out") fontSize = Math.max(6, fontSize - 1);
    else fontSize = DEFAULT_FONT_SIZE;
    try {
      restty.setFontSize(fontSize);
      restty.updateSize(true);
    } catch (_) {
      /* ignore */
    }
  });
}

// ---------------------------------------------------------------------------
// App-mouse forwarding. When the remote app requests mouse tracking (DECSET),
// translate pointer events over the terminal into SGR/X10 reports and write to
// the pty. Capture phase so restty's canvas listeners don't also act.
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

function wireAppMouse() {
  let pressedButton = null;

  const send = (kind, ev) => {
    if (!decset.isActive()) return false;
    const { col, row } = pointerToCell(ev);
    const button =
      kind === "wheel"
        ? ev.deltaY < 0
          ? 64
          : 65
        : domButtonToCode(ev.button);
    const seq = encodeMouse(kind, {
      format: decset.format(),
      button,
      col,
      row,
      mods: { shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey },
      motion: decset.motion(),
    });
    transport.sendInput(seq);
    return true;
  };

  root.addEventListener(
    "pointerdown",
    (ev) => {
      if (!decset.isActive()) return; // let restty selection work
      pressedButton = ev.button;
      if (send("down", ev)) {
        ev.preventDefault();
        ev.stopPropagation();
        root.setPointerCapture && root.setPointerCapture(ev.pointerId);
      }
    },
    true
  );
  root.addEventListener(
    "pointerup",
    (ev) => {
      if (!decset.isActive()) return;
      pressedButton = null;
      if (send("up", ev)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    },
    true
  );
  root.addEventListener(
    "pointermove",
    (ev) => {
      if (!decset.isActive()) return;
      const motion = decset.motion();
      if (motion === "none") return;
      if (motion === "drag" && pressedButton === null) return;
      // For motion reports, use the held button (or 3=released base).
      const btn = pressedButton === null ? 3 : domButtonToCode(pressedButton);
      const { col, row } = pointerToCell(ev);
      const seq = encodeMouse("move", {
        format: decset.format(),
        button: btn,
        col,
        row,
        mods: { shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey },
        motion,
      });
      transport.sendInput(seq);
      ev.preventDefault();
      ev.stopPropagation();
    },
    true
  );
  root.addEventListener(
    "wheel",
    (ev) => {
      if (!decset.isActive()) return;
      if (send("wheel", ev)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    },
    { capture: true, passive: false }
  );
}

// ---------------------------------------------------------------------------
// Emoji completion. Intercept keydown at capture phase, before restty forwards
// to the pty. The completer decides whether to consume the key.
// ---------------------------------------------------------------------------
let emojiCompleter = null;
async function wireEmoji() {
  try {
    await loadEmoji();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("emoji load failed", err);
    return;
  }
  emojiCompleter = new EmojiCompleter({
    writeToPty: (s) => transport.sendInput(s),
    getCursorRect: () => {
      // Best-effort: anchor at bottom-left of terminal (restty has no public
      // cursor-rect API). Good enough for a floating picker.
      const r = root.getBoundingClientRect();
      return { left: r.left + 8, top: r.bottom - 40, bottom: r.bottom - 8 };
    },
  });

  window.addEventListener(
    "keydown",
    (e) => {
      // Cmd/Ctrl-E toggles the feature.
      const mod = navigator.platform.startsWith("Mac") ? e.metaKey : e.ctrlKey;
      if (mod && (e.key === "e" || e.key === "E")) {
        const on = emojiCompleter.toggle();
        toast(on ? "emoji completion on" : "emoji completion off");
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const consumed = emojiCompleter.handleKeydown(e);
      if (consumed) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true // capture: run before restty's key handler
  );
}

boot();

// ---------------------------------------------------------------------------
// Drag-and-drop capture. THE point: prevent the default (which would paste the
// local file path into the terminal), capture bytes, persist via IPC, toast.
// We attach on window with capture=true so nothing downstream (restty canvas)
// ever sees the drop.
// ---------------------------------------------------------------------------
const dropHint = document.getElementById("drop-hint");
let dragDepth = 0;

function showHint(on) {
  dropHint.classList.toggle("active", on);
}

window.addEventListener(
  "dragenter",
  (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth++;
    showHint(true);
  },
  true
);

window.addEventListener(
  "dragover",
  (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  },
  true
);

window.addEventListener(
  "dragleave",
  (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showHint(false);
  },
  true
);

window.addEventListener(
  "drop",
  async (e) => {
    // CRITICAL: stop the browser/terminal default so no path text is injected.
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    showHint(false);

    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length === 0) return;

    for (const file of files) {
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        // Pass a plain Array over IPC (structured clone handles TypedArray too,
        // but Array is safest across preload boundaries).
        const res = await familiar.saveDrop(file.name, Array.from(buf));
        toast(`captured ${res.name}`);
      } catch (err) {
        toast(`drop failed: ${file.name}`);
        // eslint-disable-next-line no-console
        console.error("drop save failed", err);
      }
    }
  },
  true
);

// Refocus the terminal after any drop interaction.
window.addEventListener("mouseup", () => restty && restty.focus(), true);
