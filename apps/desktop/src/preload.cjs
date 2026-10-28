const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("filmbench", {
  rpc: (cmd, args) => ipcRenderer.invoke("rpc", { cmd, args }),
  storyboardPath: () => ipcRenderer.invoke("storyboardPath"),
  reveal: (p) => ipcRenderer.invoke("reveal", p),
});
