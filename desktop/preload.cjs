const { contextBridge, ipcRenderer } = require('electron');
const invoke = channel => async value => {
  const response = await ipcRenderer.invoke('bridge:' + channel, value);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};
contextBridge.exposeInMainWorld('bridge', {
  snapshot: invoke('snapshot'), saveSettings: invoke('save-settings'), detectCodex: invoke('detect-codex'),
  checkEnvironment: invoke('check-environment'), models: invoke('models'), threads: invoke('threads'),
  start: invoke('start'), stop: invoke('stop'), recover: invoke('recover'), doctor: invoke('doctor'),
  sendMessage: invoke('send-message'), reviewMessage: invoke('review-message'), reviewResolved: invoke('review-resolved'),
  gmMessage: invoke('gm-message'),
  pairing: invoke('pairing'), rules: invoke('rules'), saveRules: invoke('save-rules'),
  reset: invoke('reset'), choose: invoke('choose'), reveal: invoke('reveal'), exportModule: invoke('export-module'),
  onChange(callback) {
    const listener = () => callback();
    ipcRenderer.on('bridge:changed', listener);
    return () => ipcRenderer.removeListener('bridge:changed', listener);
  },
});
