const { contextBridge, ipcRenderer } = require("electron");

// Minimal, explicit surface. No Node in the renderer; all pty I/O and drop
// persistence go over IPC through this bridge.
contextBridge.exposeInMainWorld("familiar", {
  pty: {
    start: (size) => ipcRenderer.send("pty:start", size),
    write: (data) => ipcRenderer.send("pty:input", data),
    resize: (size) => ipcRenderer.send("pty:resize", size),
    onData: (cb) => {
      const h = (_e, data) => cb(data);
      ipcRenderer.on("pty:data", h);
      return () => ipcRenderer.removeListener("pty:data", h);
    },
    onExit: (cb) => {
      const h = (_e, code) => cb(code);
      ipcRenderer.on("pty:exit", h);
      return () => ipcRenderer.removeListener("pty:exit", h);
    },
    onStatus: (cb) => {
      const h = (_e, s) => cb(s);
      ipcRenderer.on("pty:status", h);
      return () => ipcRenderer.removeListener("pty:status", h);
    },
    onFatal: (cb) => {
      const h = (_e, info) => cb(info);
      ipcRenderer.on("pty:fatal", h);
      return () => ipcRenderer.removeListener("pty:fatal", h);
    },
  },
  // Persist a dropped file's bytes; returns {saved, name, bytes}.
  saveDrop: (name, bytes) => ipcRenderer.invoke("drop:save", { name, bytes }),
  // Read a bundled font's bytes from disk (avoids CSP fetch restrictions on
  // file:// URLs). Returns an ArrayBuffer.
  readFont: (name) => ipcRenderer.invoke("font:read", name),
  // Font-zoom chords (Cmd/Ctrl +/-/0) intercepted in main before they reach
  // the pty. cb receives "in" | "out" | "reset".
  onZoomFont: (cb) => {
    const h = (_e, action) => cb(action);
    ipcRenderer.on("zoom:font", h);
    return () => ipcRenderer.removeListener("zoom:font", h);
  },
});
