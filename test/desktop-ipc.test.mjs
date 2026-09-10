import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { registerIpc, validateSender, channels } from '../desktop/main/ipc.mjs';
import { createMainWindow } from '../desktop/main/window.mjs';
import { projectRoot } from '../src/runtime/config.mjs';
import { join } from 'node:path';

test('主窗口保持 sandbox / contextIsolation，renderer 无 Node 权限', () => {
  const window = createMainWindow(class { constructor(options) { this.options = options; } }, '/app/preload.cjs');
  const prefs = window.options.webPreferences;
  assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true); assert.equal(prefs.webSecurity, true);
});

function fixture() {
  const uiUrl = 'file:///app/desktop/renderer/index.html', frame = { url: uiUrl };
  const window = { webContents: { mainFrame: frame } }, handlers = new Map(), calls = [], opened = [];
  let response = 0, canceled = true;
  const controller = { idle() {}, profile: { data: { values: {} }, resources: projectRoot, config: async () => ({}) }, resetSession: async () => calls.push('reset'), importProject: async () => calls.push('import'),
    moduleInfo: async () => ({ fileName: 'module.zip' }), exportModule: async path => { calls.push(path); return { path }; } };
  const dispose = registerIpc({ ipcMain: { handle: (key, value) => handlers.set(key, value), removeHandler: key => handlers.delete(key) },
    getWindow: () => window, uiUrl, controller, shell: { openPath: async path => { opened.push(path); return ''; } }, dialog: {
      showMessageBox: async () => ({ response }), showOpenDialog: async () => ({ canceled: false, filePaths: ['/test/project'] }),
      showSaveDialog: async (_window, options) => { assert.equal(options.defaultPath, 'module.zip'); return { canceled, filePath: '/test/export/module.zip' }; },
    } });
  return { window, uiUrl, handlers, calls, opened, dispose, confirm: value => { response = value; }, cancelSave: value => { canceled = value; }, event: { sender: window.webContents, senderFrame: frame } };
}

test('桌面帮助入口打开迁移后的用户手册', async () => {
  const f = fixture();
  const response = await f.handlers.get('bridge:reveal')(f.event, 'manual');
  assert.equal(response.ok, true);
  assert.deepEqual(f.opened, [join(projectRoot, 'docs/user-manual/README.md')]);
  assert.match(await readFile(f.opened[0], 'utf8'), /^# 用户手册/);
});

test('模块导出由原生保存对话框决定目标；取消时不写入', async () => {
  const f = fixture(), exportModule = f.handlers.get('bridge:export-module');
  assert.equal((await exportModule(f.event, '/untrusted/module.zip')).value, null);
  assert.deepEqual(f.calls, []);
  f.cancelSave(false);
  assert.equal((await exportModule(f.event, '/untrusted/module.zip')).value.path, '/test/export/module.zip');
  assert.deepEqual(f.calls, ['/test/export/module.zip']);
  assert.equal((await f.handlers.get('bridge:choose')(f.event, 'foundry')).ok, false);
});

test('IPC 拒绝其他窗口、子框架和导航后的页面', () => {
  const { window, uiUrl, event } = fixture();
  validateSender(event, window, uiUrl);
  for (const bad of [{ ...event, sender: {} }, { ...event, senderFrame: { url: uiUrl } }, { ...event, senderFrame: { url: 'https://example.com' } }]) assert.throws(() => validateSender(bad, window, uiUrl), /拒绝/);
});

test('新建会话和旧版数据接管取消时无副作用，并返回明确的取消结果', async () => {
  const f = fixture();
  assert.equal((await f.handlers.get('bridge:reset')(f.event)).value, false);
  assert.equal((await f.handlers.get('bridge:choose')(f.event, 'project')).value, null);
  assert.deepEqual(f.calls, []);
  f.confirm(1);
  assert.equal((await f.handlers.get('bridge:reset')(f.event)).value, true);
  assert.deepEqual(f.calls, ['reset']);
  const denied = await f.handlers.get('bridge:choose')(f.event, 'arbitrary-file');
  assert.equal(denied.ok, false);
  assert.equal(f.handlers.size, channels.length);
  f.dispose(); assert.equal(f.handlers.size, 0);
});

test('preload 只暴露固定业务操作；不把 IPC event 传给 renderer', async () => {
  const ipc = new EventEmitter(), requests = []; let api;
  ipc.invoke = async (channel, value) => { requests.push({ channel, value }); return { ok: true, value: 'ok' }; };
  const code = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  vm.runInNewContext(code, { require: name => {
    assert.equal(name, 'electron'); return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'bridge'); api = value; } } };
  } });
  assert.equal(api.invoke, undefined); assert.equal(api.send, undefined); assert.equal(api.require, undefined);
  await api.start('manual'); assert.equal(requests[0].channel, 'bridge:start');
  await api.exportModule(); assert.equal(requests[1].channel, 'bridge:export-module');
  let delivered;
  const dispose = api.onChange((...args) => { delivered = args; });
  ipc.emit('bridge:changed', { secretEvent: true }); assert.deepEqual(delivered, []);
  dispose(); assert.equal(ipc.listenerCount('bridge:changed'), 0);
  ipc.invoke = async () => ({ ok: false, error: '已拒绝' });
  await assert.rejects(api.snapshot(), /已拒绝/);
});
