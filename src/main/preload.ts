import { contextBridge, ipcRenderer } from 'electron';

// The pages can only use these named channels, nothing else.
const INVOKE = [
  'rec:start', 'rec:stop', 'rec:bookmark', 'calls:list', 'call:get', 'call:update', 'call:retry', 'call:delete',
  'promise:toggle', 'speaker:rename', 'export:markdown', 'search', 'settings:get', 'settings:set', 'key:set', 'key:clear',
  'feedback:list', 'feedback:send', 'app:open-folder', 'panel:resize', 'app:open-library', 'detect:state'
];
const SEND = ['rec:chunk'];
const ON = ['cmd:start', 'cmd:stop', 'cmd:bookmark', 'detected', 'call-ended', 'calls-changed', 'progress', 'rec:state', 'cmd:goto'];

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, ...args: unknown[]) => (INVOKE.includes(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('blocked'))),
  send: (channel: string, ...args: unknown[]) => { if (SEND.includes(channel)) ipcRenderer.send(channel, ...args); },
  on: (channel: string, fn: (...args: unknown[]) => void) => {
    if (ON.includes(channel)) ipcRenderer.on(channel, (_event, ...args) => fn(...args));
  }
});
