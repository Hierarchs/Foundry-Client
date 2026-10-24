'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('client', Object.freeze({
  invoke: (action, payload) => ipcRenderer.invoke('client:invoke', action, payload),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('client:state', listener);
    return () => ipcRenderer.removeListener('client:state', listener);
  }
}));
