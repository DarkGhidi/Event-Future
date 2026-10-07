const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eventFuturesNative', Object.freeze({
  saveMexcCredentials: (apiKey, apiSecret) => ipcRenderer.invoke('mexc-credentials:save', { apiKey, apiSecret }),
  clearMexcCredentials: () => ipcRenderer.invoke('mexc-credentials:clear'),
  getCredentialStorageStatus: () => ipcRenderer.invoke('mexc-credentials:status')
}));
