const { contextBridge, ipcRenderer } = require('electron')
// No renderer-controlled paths, shell commands, arbitrary IPC channels, or raw Node.
contextBridge.exposeInMainWorld('worldviewDesktop', Object.freeze({
  ...(process.platform === 'darwin' ? {
    matchContactNames: people => ipcRenderer.invoke('worldview:match-contact-names',people),
    readPhotoPlaces: ({ offset = 0, requestAccess = true, includeLabels = false, snapshotToken } = {}) => ipcRenderer.invoke('worldview:photo-places', { offset, requestAccess, includeLabels, snapshotToken }),
    photoPlaceThumbnail: id => ipcRenderer.invoke('worldview:photo-thumbnail', id),
  } : {}),
  pageZoom: direction => ipcRenderer.invoke('worldview:page-zoom', direction),
  info: () => ipcRenderer.invoke('worldview:desktop-info'),
  chooseWorkspace: () => ipcRenderer.invoke('worldview:choose-workspace'),
  showWorkspace: () => ipcRenderer.invoke('worldview:show-workspace'),
  openFloatingCapture: () => ipcRenderer.invoke('worldview:open-floating-capture'),
}))
