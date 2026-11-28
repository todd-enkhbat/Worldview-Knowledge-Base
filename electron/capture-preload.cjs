const { contextBridge, ipcRenderer } = require('electron')
let modeListener = null, pendingShow = null
ipcRenderer.on('worldview:show-mode', (_event, request) => {
  if (modeListener) modeListener(request)
  else pendingShow = request
})
contextBridge.exposeInMainWorld('profileCapture', Object.freeze({
  page: () => ipcRenderer.invoke('worldview:capture-page'),
  savePage: () => ipcRenderer.invoke('worldview:capture-save-page'),
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
  followPage: () => ipcRenderer.invoke('worldview:capture-follow-page'),
  read: (mode, selectedUrl) => ipcRenderer.invoke('worldview:capture-read', mode, selectedUrl),
  openLinkedRecord: (previewId, type, id) => ipcRenderer.invoke('worldview:capture-linked-record', previewId, type, id),
  organization: (id, fields) => ipcRenderer.invoke('worldview:capture-organization', id, fields),
  profileAction: (id, action) => ipcRenderer.invoke('worldview:capture-profile-action', id, action),
  save: (id, groupId) => ipcRenderer.invoke('worldview:capture-save', id, groupId),
  openBrowser: url => ipcRenderer.invoke('worldview:capture-browser', url),
  openRecord: (action, previewId) => ipcRenderer.invoke('worldview:capture-record', action, previewId),
  screenState: () => ipcRenderer.invoke('worldview:capture-screen-state'),
  screenStart: () => ipcRenderer.invoke('worldview:capture-screen-start'),
  screenNow: () => ipcRenderer.invoke('worldview:capture-screen-now'),
  screenPause: () => ipcRenderer.invoke('worldview:capture-screen-pause'),
  screenSettings: () => ipcRenderer.invoke('worldview:capture-screen-settings'),
  screenRestart: () => ipcRenderer.invoke('worldview:capture-screen-restart'),
  screenPaste: value => ipcRenderer.invoke('worldview:capture-screen-paste', value),
  screenDismiss: id => ipcRenderer.invoke('worldview:capture-screen-dismiss', id),
  screenSave: (id, fields) => ipcRenderer.invoke('worldview:capture-screen-save', id, fields),
  onScreenContacts: callback => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('worldview:screen-contacts', listener)
    return () => ipcRenderer.removeListener('worldview:screen-contacts', listener)
  },
  close: () => ipcRenderer.invoke('worldview:capture-close'),
}))
