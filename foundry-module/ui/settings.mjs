import { MODULE_ID, validatePairing, ROUTES } from '../shared/protocol.mjs';
import { signedPost } from '../relay/transport.mjs';

export function settingsApplication({ game, ApplicationV2, notify, restart, controller }) {
  return class BridgeSettings extends ApplicationV2 {
    static DEFAULT_OPTIONS = { id: 'familiar-agent-bridge-settings', classes: ['familiar-bridge-settings'],
      window: { title: 'Familiar Agent Bridge', icon: 'fa-solid fa-link', resizable: true }, position: { width: 580, height: 'auto' } };

    async _renderHTML() {
      if (!game.user.isGM) throw new Error('只有 GM 可以配置 Bridge');
      const root = document.createElement('div');
      root.className = 'standard-form';
      root.innerHTML = `<p>由本 GM 浏览器转发玩家的 @familiar 消息。先在本机运行 setup:foundry，再导入生成的配对文件。</p>
        <label>配对文件（只保存在本浏览器）<input type="file" accept="application/json,.json" data-pairing></label>
        <p data-summary></p><label><input type="checkbox" data-enabled> 启用玩家消息推送</label>
        <label><input type="checkbox" data-gm> 也接受 GM 手工输入的 @familiar（默认只接受玩家）</label>
        <p>启用前请关闭 Familiar 的 Table Chat 自动回答。使用此 GM 账号，并保持一个已连接的游戏页面打开。</p>
        <p data-runtime></p><footer class="form-footer"><button type="button" data-test>测试连接</button>
        <button type="button" data-retry>重试待发消息</button><button type="button" data-save>保存并应用</button></footer>`;
      let pending = game.settings.get(MODULE_ID, 'pairing');
      const summary = root.querySelector('[data-summary]');
      const updateSummary = () => { summary.textContent = pending?.worldId ? `世界：${pending.worldId}；GM：${pending.relayUserId}；地址：${pending.bridgeUrl}` : '尚未导入配对文件。'; };
      updateSummary();
      root.querySelector('[data-enabled]').checked = game.settings.get(MODULE_ID, 'enabled');
      root.querySelector('[data-gm]').checked = game.settings.get(MODULE_ID, 'allowGmRequests');
      root.querySelector('[data-runtime]').textContent = controller()?.status() ?? '尚未启动';
      const action = handler => async () => { try { await handler(); } catch (error) { notify(error.message, 'error'); } };
      root.querySelector('[data-pairing]').addEventListener('change', action(async () => {
        const file = root.querySelector('[data-pairing]').files[0];
        if (!file || file.size > 8192) throw new Error('请选择小于 8 KiB 的配对 JSON 文件');
        let parsed;
        try { parsed = JSON.parse(await file.text()); } catch { throw new Error('配对 JSON 无效'); }
        pending = validatePairing(parsed);
        if (pending.worldId !== game.world.id || pending.relayUserId !== game.user.id) throw new Error('配对文件必须属于当前世界和当前 GM');
        updateSummary();
      }));
      root.querySelector('[data-test]').addEventListener('click', action(async () => {
        const result = await signedPost(validatePairing(pending), ROUTES.status, { ids: [] });
        notify(result.ready ? 'Bridge 与 Familiar 已就绪。' : '已连接 Bridge，Familiar 或 Queue 目前暂停。', result.ready ? 'info' : 'warn');
      }));
      root.querySelector('[data-retry]').addEventListener('click', action(async () => { await controller()?.retry(); notify('已请求重试待发消息；已接收的请求不会重放。', 'info'); }));
      root.querySelector('[data-save]').addEventListener('click', action(async () => {
        const pairing = validatePairing(pending);
        if (pairing.worldId !== game.world.id || pairing.relayUserId !== game.user.id) throw new Error('只能由配对的 GM 在对应世界启用');
        const enabled = root.querySelector('[data-enabled]').checked;
        if (enabled && game.settings.get('familiar', 'tableChatEnabled')) throw new Error('请先关闭 Familiar 的 Table Chat 自动回答，避免双重回复');
        await controller()?.stop();
        await game.settings.set(MODULE_ID, 'pairing', pairing);
        await game.settings.set(MODULE_ID, 'relayUserId', game.user.id);
        await game.settings.set(MODULE_ID, 'allowGmRequests', root.querySelector('[data-gm]').checked);
        if (enabled && !game.settings.get(MODULE_ID, 'enabled')) await game.settings.set(MODULE_ID, 'enabledSince', Date.now());
        await game.settings.set(MODULE_ID, 'enabled', enabled);
        await restart();
        notify('Bridge 配置已保存。', 'info');
        await this.close();
      }));
      return root;
    }

    _replaceHTML(result, content) { content.replaceChildren(result); }
  };
}
