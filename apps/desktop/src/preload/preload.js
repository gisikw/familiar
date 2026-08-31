const { contextBridge, ipcRenderer } = require("electron");

// ---------------------------------------------------------------------------
// The client is a dumb chrome shell: the served terminal page owns all terminal
// I/O, uploads, mouse, and emoji. The ONLY thing the preload exposes is a tiny
// bridge for the bundled offline/retry page (src/main/offline.html) to ask the
// main process to re-load the app. The served page (remote origin) does NOT get
// this preload's globals for anything privileged — it's a normal web page.
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld("familiar", {
  // Offline page: retry loading the configured base URL now.
  retry: () => ipcRenderer.send("app:retry"),
  // Offline page: fetch the resolved base URL (for display).
  baseUrl: () => ipcRenderer.invoke("app:baseUrl"),
  saveBaseUrl: (value) => ipcRenderer.invoke("app:saveBaseUrl", value),
});
