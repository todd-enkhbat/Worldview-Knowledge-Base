const { contextBridge, ipcRenderer } = require('electron')
let modeListener = null, pendingShow = null
ipcRenderer.on('worldview:show-mode', (_event, request) => {
  if (modeListener) modeListener(request)
  else pendingShow = request
})
contextBridge.exposeInMainWorld('profileCapture', Object.freeze({
  mode: value => ipcRenderer.invoke('worldview:capture-mode',value),
  onShowMode: callback => {
    modeListener = callback
    if (pendingShow) { const request = pendingShow; pendingShow = null; callback(request) }
    return () => { if (modeListener === callback) modeListener = null }
  },
  celebrate: () => ipcRenderer.invoke('worldview:capture-celebrate'),
  selection: () => ipcRenderer.invoke('worldview:capture-selection'),
  shortcut: value => value === undefined ? ipcRenderer.invoke('worldview:capture-shortcut') : ipcRenderer.invoke('worldview:capture-shortcut',value),
  form: mode => ipcRenderer.invoke('worldview:capture-form',mode),
  ocr: () => ipcRenderer.invoke('worldview:capture-ocr'),
  listVisiblePeople: mode => ipcRenderer.invoke('worldview:capture-people', mode),
  read: (mode, selectedUrl) => ipcRenderer.invoke('worldview:capture-read', mode, selectedUrl),
  profileAction: (id, action) => ipcRenderer.invoke('worldview:capture-profile-action', id, action),
  save: (id, groupId) => ipcRenderer.invoke('worldview:capture-save', id, groupId),
  openBrowser: url => ipcRenderer.invoke('worldview:capture-browser', url),
  openRecord: (action, previewId) => ipcRenderer.invoke('worldview:capture-record', action, previewId),
  close: () => ipcRenderer.invoke('worldview:capture-close'),
}))
