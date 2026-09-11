import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { ProfileStore } from './profile-store.mjs';
import { DesktopController } from './controller.mjs';
import { registerIpc } from './ipc.mjs';
import { redact } from '../../src/runtime/logger.mjs';
import { createMainWindow } from './window.mjs';
import { prepareDevelopmentData } from './application-paths.mjs';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
app.setName('Familiar Agent Bridge');
prepareDevelopmentData(app, sourceRoot);
const resources = app.isPackaged ? join(process.resourcesPath, 'bridge-resources') : sourceRoot;
const uiFile = join(sourceRoot, 'desktop/renderer/index.html');
const uiUrl = pathToFileURL(uiFile).href;
let window, controller, quitting = false, shutdown;

async function quit() {
  if (shutdown) return shutdown;
  shutdown = (async () => {
    try { await controller?.shutdown(); quitting = true; app.quit(); }
    catch (error) { dialog.showErrorBox('尚未完成关闭', redact(error.message)); shutdown = null; }
  })();
  return shutdown;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quit(); } });
  process.on('SIGTERM', () => { void quit(); });
  process.on('SIGINT', () => { void quit(); });
  // Electron 要等入口 ESM 完成求值才触发 ready；顶层 await whenReady 会互相等待。
  void app.whenReady().then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
    const profile = new ProfileStore(app.getPath('userData'), resources);
    await profile.load();
    controller = new DesktopController(profile);
    window = createMainWindow(BrowserWindow, join(sourceRoot, 'desktop/preload.cjs'));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    ]));
    registerIpc({ ipcMain, dialog, shell, controller, getWindow: () => window, uiUrl });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.on('render-process-gone', () => { void quit(); });
    window.on('close', event => { if (!quitting) { event.preventDefault(); void quit(); } });
    let pending;
    controller.on('change', () => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; if (!window.isDestroyed()) window.webContents.send('bridge:changed'); }, 100);
    });
    await window.loadFile(uiFile);
    window.show();
    console.log('桌面窗口已打开。关闭窗口或按 Ctrl+C 退出。');
  }).catch(async error => { dialog.showErrorBox('应用无法启动', redact(error.message)); await quit(); });
}
