const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("videoStudio", {
  generateVideo: (payload) => ipcRenderer.invoke("generate-video", payload),
  openOutputFolder: (savedPath) => ipcRenderer.invoke("open-output-folder", savedPath)
});
