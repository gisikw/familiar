import { Restty } from "./vendor/restty.esm.js";

const { familiar } = window;

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
      offData = familiar.pty.onData((data) => cbs.onData && cbs.onData(data));
      offExit = familiar.pty.onExit(
        (code) => cbs.onExit && cbs.onExit(code | 0)
      );
      offStatus = familiar.pty.onStatus(
        (s) => cbs.onStatus && cbs.onStatus(s.shell || "shell")
      );
      familiar.pty.start({ cols: options.cols || 80, rows: options.rows || 24 });
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
    "  1. Rebuild the native module for Electron:  npm run rebuild",
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

async function boot() {
  // Load bundled font bytes via IPC (CSP blocks fetch() of file:// fonts).
  // Pass as in-memory buffers so restty never touches the network.
  let fonts;
  try {
    const [regular, bold, italic] = await Promise.all([
      familiar.readFont("JetBrainsMono-Regular.ttf"),
      familiar.readFont("JetBrainsMono-Bold.ttf"),
      familiar.readFont("JetBrainsMono-Italic.ttf"),
    ]);
    fonts = [
      { data: regular },
      { data: bold, weight: 700 },
      { data: italic, style: "italic" },
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
      fontSize: 14,
      autoResize: true, // restty syncs cols/rows -> transport.resize on layout
      ...(fonts ? { fonts } : {}),
    },
  });

  // Kick the connection. URL is unused by our transport but the API wants a call.
  restty.connectPty("ipc://familiar");
  restty.focus();

  // Expose selected renderer backend for diagnostics/self-test.
  try {
    window.__familiarBackend = restty.getBackend();
  } catch (_) {
    window.__familiarBackend = "unknown";
  }
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
