const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('enkiPet', Object.freeze({
  activate: () => ipcRenderer.send('enki:activate'),
  hide: () => ipcRenderer.send('enki:hide'),
  menu: () => ipcRenderer.send('enki:menu'),
  drag: phase => { if (['start', 'move', 'end'].includes(phase)) ipcRenderer.send('enki:drag', phase) },
  onOrient: callback => { ipcRenderer.on('enki:orient', (_event, command) => callback(command)) },
  onCelebrate: callback => { ipcRenderer.on('enki:celebrate', () => callback()) },
  openScreenContact: () => ipcRenderer.send('enki:screen-contact'),
  onScreenContact: callback => { ipcRenderer.on('enki:screen-contact', (_event, value) => callback(value)) },
}))
