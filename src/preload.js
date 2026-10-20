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

  appInfo: () => ipcRenderer.invoke('app:info'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('update:progress', fn);
    return () => ipcRenderer.removeListener('update:progress', fn);
  },
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  systemSpecs: (force) => ipcRenderer.invoke('system:specs', force),
  ollamaTags: () => ipcRenderer.invoke('ollama:tags'),
  ollamaPull: (model) => ipcRenderer.invoke('ollama:pull', model),
  ollamaPullCancel: (model) => ipcRenderer.invoke('ollama:pull-cancel', model),
  ollamaShow: (model) => ipcRenderer.invoke('ollama:show', model),
  hfResolve: (repo) => ipcRenderer.invoke('hf:resolve', repo),
  onPullProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('ollama:pull-progress', fn);
    return () => ipcRenderer.removeListener('ollama:pull-progress', fn);
  },

  convList: (workspace) => ipcRenderer.invoke('conv:list', workspace),
  convLoad: (id) => ipcRenderer.invoke('conv:load', id),
  convSave: (conv) => ipcRenderer.invoke('conv:save', conv),
  convDelete: (id) => ipcRenderer.invoke('conv:delete', id),

  listModels: () => ipcRenderer.invoke('model:list'),
  chatStream: (id, payload) => ipcRenderer.invoke('chat:stream', id, payload),
  chatAbort: (id) => ipcRenderer.invoke('chat:abort', id),
  onChatEvent: (cb) => {
    const fn = (_e, ev) => cb(ev);
    ipcRenderer.on('chat:event', fn);
    return () => ipcRenderer.removeListener('chat:event', fn);
  }
});
