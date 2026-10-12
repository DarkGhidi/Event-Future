const { contextBridge, ipcRenderer } = require('electron');
const invoke = (method, args) => ipcRenderer.invoke('maxibot:' + method, args);
contextBridge.exposeInMainWorld('maxibot', {
  state: lane => invoke('state', lane),
  connectChatGPT: newProfile => invoke('chatgpt-connect', {newProfile: newProfile === true}),
  disconnectChatGPT: () => invoke('chatgpt-disconnect'),
  models: () => invoke('models'),
  connectMexc: keys => invoke('mexc-connect', keys),
  disconnectMexc: () => invoke('mexc-disconnect'),
  start: settings => invoke('start', settings),
  pause: value => invoke('pause', value),
  stop: () => invoke('stop'),
  newRun: () => invoke('new-run'),
  openGuide: guide => invoke('open-guide', guide),
  exportReport: () => invoke('export'),
  onUpdate: handler => { const fn = () => handler(); ipcRenderer.on('maxibot:update',fn); return () => ipcRenderer.removeListener('maxibot:update',fn); }
});
