export function createMainWindow(BrowserWindow, preload) {
  return new BrowserWindow({ width: 1280, height: 880, minWidth: 1060, minHeight: 720, title: 'Familiar Agent Bridge',
    backgroundColor: '#f5f6f2', show: false, titleBarStyle: 'hiddenInset',
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
}
