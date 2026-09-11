import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const ready = deferred();
export const loaded = deferred(), shown = deferred(), closed = deferred();
export const windows = [], errors = [], calls = [];
export const app = new EventEmitter();
const paths = new Map();
let isReady = false;
Object.assign(app, {
  isPackaged: false,
  setName(name) { this.name = name; },
  setPath(name, path) { assert.equal(isReady, false); paths.set(name, path); calls.push('set-path'); },
  getPath(name) { return paths.get(name); },
  requestSingleInstanceLock() { calls.push('lock'); return process.env.DESKTOP_TEST_SCENARIO !== 'second-instance'; },
  whenReady() { calls.push('when-ready'); return ready.promise; },
  finishReady() { isReady = true; ready.resolve(); },
  quit() {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    this.emit('before-quit', event);
    if (!event.prevented) {
      for (const window of windows) window.destroyed = true;
      closed.resolve();
    }
  },
});

export class BrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    assert.equal(isReady, true, '窗口只能在 ready 之后创建');
    this.options = options;
    this.visible = false;
    this.webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler() {},
      send() {},
      session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
    });
    windows.push(this);
  }
  async loadFile(file) { this.file = file; calls.push('load-file'); await loaded.promise; }
  show() { this.visible = true; shown.resolve(); }
  isDestroyed() { return Boolean(this.destroyed); }
}

export const ipcMain = { handle() {}, removeHandler() {} };
export const dialog = { showErrorBox(title, message) { errors.push({ title, message }); } };
export const shell = {};
export const Menu = { buildFromTemplate: template => template, setApplicationMenu() {} };
