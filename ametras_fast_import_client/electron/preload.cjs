const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  files: {
    select: () => ipcRenderer.invoke('files:select'),
    register: (paths) => ipcRenderer.invoke('files:register', paths),
    read: (id, encoding) => ipcRenderer.invoke('files:read', id, encoding),
    readHead: (id, bytes, encoding) => ipcRenderer.invoke('files:readHead', id, bytes, encoding),
    countLines: (id) => ipcRenderer.invoke('files:countLines', id),
    getPathForFile: (file) => webUtils.getPathForFile(file),
    streamChunks: async (id, chunkLines, onChunk, encoding) => {
      const streamId = await ipcRenderer.invoke('files:streamChunks', id, chunkLines, encoding);
      return new Promise((resolve, reject) => {
        const handler = (_event, chunk) => {
          onChunk(chunk);
          if (chunk.done) {
            ipcRenderer.removeListener(`files:chunk:${streamId}`, handler);
            if (chunk.error) {
              reject(new Error(chunk.error));
            } else {
              resolve();
            }
          }
        };
        ipcRenderer.on(`files:chunk:${streamId}`, handler);
      });
    },
    // Async streaming with backpressure support
    streamStart: (id, chunkLines, encoding) =>
      ipcRenderer.invoke('files:streamStart', id, chunkLines, encoding),
    streamNext: (streamId) =>
      ipcRenderer.invoke('files:streamNext', streamId),
    streamClose: (streamId) =>
      ipcRenderer.invoke('files:streamClose', streamId)
  },
  odoo: {
    call: (payload) => ipcRenderer.invoke('odoo:call', payload),
    authenticate: (params) => ipcRenderer.invoke('odoo:authenticate', params),
    listDatabases: (baseUrl) => ipcRenderer.invoke('odoo:listDatabases', baseUrl),
    ping: (baseUrl) => ipcRenderer.invoke('odoo:ping', baseUrl)
  },
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value)
  },
  profile: {
    selectZip: () => ipcRenderer.invoke('profile:selectZip'),
    upload: (payload) => ipcRenderer.invoke('profile:upload', payload),
    export: (payload) => ipcRenderer.invoke('profile:export', payload)
  },
  standalone: {
    detectAddon: (payload) => ipcRenderer.invoke('standalone:detectAddon', payload),
    load: (payload) => ipcRenderer.invoke('standalone:load', payload),
    getOdooVersion: (payload) => ipcRenderer.invoke('standalone:getOdooVersion', payload)
  }
});
