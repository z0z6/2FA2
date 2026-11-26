'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

contextBridge.exposeInMainWorld('api', {
  info: () => call('app:info'),
  windowControl: (a) => call('window:control', a),
  read: (key) => call('store:read', key),
  write: (key, value) => call('store:write', key, value),
  autoKeyGet: () => call('autokey:get'),
  autoKeySet: (b64) => call('autokey:set', b64),
  copy: (text, clearMs) => call('clipboard:copy', text, clearMs),
  saveFile: (name, text) => call('file:save', name, text),
  captureScreens: () => call('screen:capture'),
  openExternal: (url) => call('shell:openExternal', url),
  on: (channel, fn) => {
    const allowed = ['window:state', 'app:lock'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  }
});
