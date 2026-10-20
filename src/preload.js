const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  setWorkspace: (dir) => ipcRenderer.invoke('workspace:set', dir),

  list: (rel) => ipcRenderer.invoke('fs:list', rel),
  listRecursive: (rel, limit, maxDepth) => ipcRenderer.invoke('fs:listRecursive', rel, limit, maxDepth),
  read: (rel) => ipcRenderer.invoke('fs:read', rel),
  exists: (rel) => ipcRenderer.invoke('fs:exists', rel),
  write: (rel, content) => ipcRenderer.invoke('fs:write', rel, content),
  mkdir: (rel) => ipcRenderer.invoke('fs:mkdir', rel),
  remove: (rel, opts) => ipcRenderer.invoke('fs:delete', rel, opts),
  search: (query, opts) => ipcRenderer.invoke('fs:search', query, opts),
  reveal: (rel) => ipcRenderer.invoke('shell:reveal', rel),

  runCommand: (command, timeoutMs) => ipcRenderer.invoke('cmd:run', command, timeoutMs),
  onCommandOutput: (cb) => {
    const fn = (_e, text) => cb(text);
    ipcRenderer.on('cmd:output', fn);
    return () => ipcRenderer.removeListener('cmd:output', fn);
  },

  listModels: () => ipcRenderer.invoke('model:list'),
  chatStream: (id, payload) => ipcRenderer.invoke('chat:stream', id, payload),
  chatAbort: (id) => ipcRenderer.invoke('chat:abort', id),
  onChatEvent: (cb) => {
    const fn = (_e, ev) => cb(ev);
    ipcRenderer.on('chat:event', fn);
    return () => ipcRenderer.removeListener('chat:event', fn);
  }
});
