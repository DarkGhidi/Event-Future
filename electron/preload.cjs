const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eventFuturesNative', Object.freeze({
  saveMexcCredentials: (apiKey, apiSecret) => ipcRenderer.invoke('mexc-credentials:save', { apiKey, apiSecret }),
  clearMexcCredentials: () => ipcRenderer.invoke('mexc-credentials:clear'),
  getCredentialStorageStatus: () => ipcRenderer.invoke('mexc-credentials:status'),
  saveBotCredentials: (apiKey, apiSecret) => ipcRenderer.invoke('mexc-bot-credentials:save', { apiKey, apiSecret }),
  clearBotCredentials: () => ipcRenderer.invoke('mexc-bot-credentials:clear'),
  getBotCredentialStorageStatus: () => ipcRenderer.invoke('mexc-bot-credentials:status'),
  keepAwakeForBot: () => ipcRenderer.invoke('bot-runtime:keep-awake'),
  allowSleepAfterBot: () => ipcRenderer.invoke('bot-runtime:allow-sleep')
}));
