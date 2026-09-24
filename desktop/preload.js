'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程只能通过这组白名单 API 与主进程通信：
 * 网络请求与 token 都留在主进程，renderer 里没有 Node 权限，也拿不到 token。
 */
const api = {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },

  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  testConnection: (payload) => ipcRenderer.invoke('connection:test', payload),
  saveConnection: (payload) => ipcRenderer.invoke('connection:save', payload),
  pickWidget: () => ipcRenderer.invoke('dialog:pickWidget'),

  // 待办操作
  add: (text) => ipcRenderer.invoke('todos:add', text),
  toggle: (id, done) => ipcRenderer.invoke('todos:toggle', { id, done }),
  remove: (id) => ipcRenderer.invoke('todos:remove', id),
  updateText: (id, text) => ipcRenderer.invoke('todos:updateText', { id, text }),
  clearDone: () => ipcRenderer.invoke('todos:clearDone'),
  syncNow: () => ipcRenderer.invoke('sync:now'),

  // 窗口
  openSettings: () => ipcRenderer.invoke('window:openSettings'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  closeApp: () => ipcRenderer.invoke('window:close'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  setClickThrough: (value) => ipcRenderer.invoke('window:setClickThrough', value),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
};

contextBridge.exposeInMainWorld('flatnas', api);
