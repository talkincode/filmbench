const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("filmbench", {
  rpc: (cmd, args) => ipcRenderer.invoke("rpc", { cmd, args }),
  project: () => ipcRenderer.invoke("project"),
  projects: () => ipcRenderer.invoke("projects"),
  pickProject: () => ipcRenderer.invoke("pick-project"),
  useProject: (dir) => ipcRenderer.invoke("use-project", dir),
  capture: () => ipcRenderer.invoke("capture"),
  clipboardImage: (dataUrl) => ipcRenderer.invoke("clipboard-image", dataUrl),
  clipboardText: (text) => ipcRenderer.invoke("clipboard-text", text),
  openPath: (p) => ipcRenderer.invoke("open-path", p),
  reveal: (p) => ipcRenderer.invoke("reveal", p),
  onFocusShot: (cb) => ipcRenderer.on("focus-shot", (_e, id) => cb(id)),
  onOpenProject: (cb) => ipcRenderer.on("open-project", (_e, payload) => cb(payload)),
});
