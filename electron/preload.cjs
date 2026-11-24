const { contextBridge, ipcRenderer } = require('electron')
// No renderer-controlled paths, shell commands, arbitrary IPC channels, or raw Node.
contextBridge.exposeInMainWorld('worldviewDesktop', Object.freeze({
  info: () => ipcRenderer.invoke('worldview:desktop-info'),
  chooseWorkspace: () => ipcRenderer.invoke('worldview:choose-workspace'),
  showWorkspace: () => ipcRenderer.invoke('worldview:show-workspace'),
}))
