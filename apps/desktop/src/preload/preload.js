const { contextBridge, ipcRenderer } = require("electron");

// ---------------------------------------------------------------------------
// The client is a dumb chrome shell: the served app owns all browser behavior
// and network I/O. The ONLY thing the preload exposes is a tiny
// bridge for the bundled offline/settings pages. The preload also executes in
// remote documents loaded by the same BrowserWindow, but the main process
// authorizes every IPC call against the exact bundled file URL. Remote origins
// therefore get no privileged operation from these inert wrapper functions.
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld("familiar", {
  // Offline page: retry loading the configured base URL now.
  retry: () => ipcRenderer.send("app:retry"),
  // Offline page: fetch the resolved base URL (for display).
  baseUrl: () => ipcRenderer.invoke("app:baseUrl"),
  saveBaseUrl: (value) => ipcRenderer.invoke("app:saveBaseUrl", value),
});
