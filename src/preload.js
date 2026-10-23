const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  send: (text) => ipcRenderer.invoke('send-message', text),
  stop: () => ipcRenderer.invoke('stop'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  dragBy: (dx, dy) => ipcRenderer.send('drag-by', dx, dy),
  zoom: () => ipcRenderer.send('zoom-window'),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent-event', listener);
    return () => ipcRenderer.removeListener('agent-event', listener);
  },
});
