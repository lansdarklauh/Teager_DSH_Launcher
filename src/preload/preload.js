'use strict';

/**
 * 预加载脚本：在隔离上下文中向界面暴露受限的 API（window.hd），界面无法直接访问 Node 能力。
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 订阅主进程推送的消息。
 * @param {string} channel 通道
 * @param {(payload: any) => void} fn 回调
 */
const on = (channel, fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload));

contextBridge.exposeInMainWorld('hd', {
  init: () => ipcRenderer.invoke('app:init'),
  restart: () => ipcRenderer.invoke('svc:restart'),
  stop: () => ipcRenderer.invoke('svc:stop'),
  start: () => ipcRenderer.invoke('svc:start'),
  redetect: () => ipcRenderer.invoke('app:redetect'),
  installStart: () => ipcRenderer.invoke('install:start'),
  installSetup: () => ipcRenderer.invoke('install:setup'),
  installBegin: (opts) => ipcRenderer.invoke('install:begin', opts),
  installCancel: () => ipcRenderer.invoke('install:cancel'),
  saveConfig: (patch) => ipcRenderer.invoke('cfg:save', patch),
  applyRestart: () => ipcRenderer.invoke('cfg:apply-restart'),
  pickFile: (kind) => ipcRenderer.invoke('dialog:pick-file', kind),
  detectTools: () => ipcRenderer.invoke('tools:detect'),
  probeRegistries: (custom) => ipcRenderer.invoke('registry:probe', custom),
  getVersions: () => ipcRenderer.invoke('dsh:versions'),
  updateDsh: (version) => ipcRenderer.invoke('dsh:update', { version }),
  dismissUpdate: () => ipcRenderer.invoke('dsh:update-dismiss'),
  onUpdateProgress: (fn) => on('update-progress', fn),
  pickDir: (title) => ipcRenderer.invoke('dialog:pick-dir', title),
  runCommand: (line) => ipcRenderer.invoke('cmd:run', line),
  sendInput: (text) => ipcRenderer.invoke('cmd:input', text),
  stopCommand: () => ipcRenderer.invoke('cmd:stop'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  openPath: (which) => ipcRenderer.invoke('open:path', which),
  closeChoice: (action, remember) => ipcRenderer.invoke('win:close-choice', { action, remember }),
  quit: () => ipcRenderer.invoke('app:quit'),
  dismissPlugins: () => ipcRenderer.invoke('plugins:dismiss'),
  installPlugin: (payload) => ipcRenderer.invoke('plugin:install', payload),
  cancelPluginInstall: () => ipcRenderer.invoke('plugin:cancel'),
  onState: (fn) => on('state', fn),
  onLogs: (fn) => on('logs', fn),
  onInstallProgress: (fn) => on('install-progress', fn),
  onAskClose: (fn) => on('ask-close', fn),
  onCmdBusy: (fn) => on('cmd-busy', fn),
  onToggleConsole: (fn) => on('toggle-console', fn),
});
