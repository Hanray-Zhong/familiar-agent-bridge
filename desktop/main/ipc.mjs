import { join } from 'node:path';
import { redact } from '../../src/runtime/logger.mjs';

export const channels = ['snapshot', 'save-settings', 'detect-codex', 'check-environment', 'models', 'threads',
  'start', 'stop', 'recover', 'doctor', 'send-message', 'review-message', 'review-resolved', 'gm-message', 'pairing', 'rules', 'save-rules',
  'reset', 'choose', 'reveal', 'export-module'];

export function validateSender(event, window, uiUrl) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== uiUrl) {
    throw new Error('拒绝来自非应用主界面的请求');
  }
}

export function registerIpc({ ipcMain, dialog, shell, controller, getWindow, uiUrl }) {
  const confirm = async message => (await dialog.showMessageBox(getWindow(), { type: 'warning', title: '确认操作',
    message, buttons: ['取消', '继续'], defaultId: 0, cancelId: 0, noLink: true })).response === 1;
  const choose = async type => {
    if (!['codex', 'project', 'pairing'].includes(type)) throw new Error('不支持的文件选择类型');
    controller.idle();
    const result = await dialog.showOpenDialog(getWindow(), { title: { codex: '选择已安装的 Codex 程序',
      project: '选择要接管的 Bridge 项目', pairing: '选择已有的私有配对文件' }[type],
      properties: type === 'project' ? ['openDirectory'] : ['openFile', 'showHiddenFiles'],
      ...(type === 'pairing' ? { filters: [{ name: '配对 JSON', extensions: ['json'] }] } : {}) });
    if (result.canceled) return null;
    const path = result.filePaths[0];
    if (type === 'codex') await controller.saveSettings({ ...controller.profile.data.values, CODEX_COMMAND: path });
    if (type === 'pairing') await controller.importPairing(path);
    if (type === 'project') {
      if (!await confirm('接管旧版项目的对话状态和配对文件。请先停止旧版 Bridge；原数据文件继续使用，不会复制或重置。')) return null;
      await controller.importProject(path);
    }
    return path;
  };
  const reveal = async type => {
    const config = await controller.profile.config();
    const paths = { data: controller.profile.directory, rules: config.instructionsFile, pairing: config.foundryPairingFile,
      manual: join(controller.profile.resources, 'docs/user-manual/README.md') };
    if (!Object.hasOwn(paths, type)) throw new Error('不支持的打开目标');
    if (type === 'pairing' || type === 'rules') shell.showItemInFolder(paths[type]);
    else { const error = await shell.openPath(paths[type]); if (error) throw new Error(error); }
  };
  const actions = {
    snapshot: () => controller.snapshot(), 'save-settings': values => controller.saveSettings(values),
    'detect-codex': () => controller.detectCodex(), 'check-environment': () => controller.checkEnvironment(), models: () => controller.fetchModels(),
    threads: query => controller.fetchThreads(query), start: mode => controller.start(mode), stop: () => controller.stop(),
    recover: () => controller.recover(), doctor: () => controller.doctor(), 'send-message': text => controller.sendMessage(text),
    'review-message': value => controller.reviewMessage(value), 'review-resolved': value => controller.setReviewResolved(value),
    'gm-message': text => controller.gmMessage(text),
    pairing: async values => {
      if (values?.rotate && !await confirm('将生成新的配对密钥。保存后需要在指定 GM 的 Foundry 页面重新导入配对文件。')) return null;
      return controller.configurePairing(values);
    },
    rules: () => controller.getRules(), 'save-rules': text => controller.saveRules(text),
    reset: async () => { if (!await confirm('取消旧会话尚未处理的请求，并解除固定对话 ID。下一次启动创建新对话。已经执行的游戏操作不会回滚。')) return false; await controller.resetSession(); return true; },
    choose, reveal,
    'export-module': async () => {
      controller.idle();
      const { fileName } = await controller.moduleInfo();
      const result = await dialog.showSaveDialog(getWindow(), { title: '保存 Foundry 模块安装包', defaultPath: fileName,
        filters: [{ name: 'Foundry 模块 ZIP', extensions: ['zip'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
      if (result.canceled || !result.filePath) return null;
      return controller.exportModule(result.filePath);
    },
  };
  for (const channel of channels) ipcMain.handle(`bridge:${channel}`, async (event, value) => {
    try { validateSender(event, getWindow(), uiUrl); return { ok: true, value: await actions[channel](value) }; }
    catch (error) { return { ok: false, error: redact(error.message) }; }
  });
  return () => { for (const channel of channels) ipcMain.removeHandler(`bridge:${channel}`); };
}
