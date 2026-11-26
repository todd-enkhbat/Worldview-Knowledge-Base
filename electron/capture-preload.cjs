const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('profileCapture', Object.freeze({
  mode: value => ipcRenderer.invoke('worldview:capture-mode',value),
  selection: () => ipcRenderer.invoke('worldview:capture-selection'),
  shortcut: value => value === undefined ? ipcRenderer.invoke('worldview:capture-shortcut') : ipcRenderer.invoke('worldview:capture-shortcut',value),
  form: mode => ipcRenderer.invoke('worldview:capture-form',mode),
  ocr: () => ipcRenderer.invoke('worldview:capture-ocr'),
  read: mode => ipcRenderer.invoke('worldview:capture-read', mode),
  save: (id, groupId) => ipcRenderer.invoke('worldview:capture-save', id, groupId),
  openBrowser: url => ipcRenderer.invoke('worldview:capture-browser', url),
  openRecord: () => ipcRenderer.invoke('worldview:capture-record'),
  compact: value => ipcRenderer.invoke('worldview:capture-compact', value),
  fit: height => ipcRenderer.invoke('worldview:capture-fit', height),
  close: () => ipcRenderer.invoke('worldview:capture-close'),
}))
