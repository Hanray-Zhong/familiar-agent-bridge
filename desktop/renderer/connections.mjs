const defaults = {
  codex: '等待检查 Codex 与 Familiar 服务配置',
  world: '保存配对后，运行世界只读测试',
  push: '启动 Bridge 后，在 Foundry 中测试连接',
};
const stateNames = { untested: '待测试', checking: '测试中', passed: '已通过', failed: '未通过' };

export function renderConnections(state) {
  const get = id => document.getElementById(id);
  const active = ['running', 'paused'].includes(state.status.phase);
  for (const [key, index, textId, dotId, iconId] of [
    ['codex', 1, 'codex-state', 'codex-dot', 'check-cli'],
    ['world', 2, 'world-state', 'world-dot', 'check-pair'],
    ['push', 3, 'push-state', 'push-dot', 'check-push'],
  ]) {
    const check = state.connections?.[key] || { state: 'untested', message: defaults[key] };
    const passed = check.state === 'passed';
    const label = passed && !active ? '上次测试通过' : stateNames[check.state];
    const message = `${label} · ${check.message}`;
    for (const id of [textId, `setup-${key}-result`, `connection-${key}-result`]) {
      get(id).textContent = message;
      get(id).title = check.checkedAt ? `最近验证：${new Date(check.checkedAt).toLocaleString('zh-CN', { hour12: false })}` : '';
      get(id).className = `connection-result ${check.state}`;
    }
    get(dotId).classList.toggle('ok', passed);
    get(dotId).classList.toggle('failed', check.state === 'failed');
    for (const id of [iconId, `step-${key}`]) {
      get(id).textContent = passed ? '✓' : check.state === 'failed' ? '!' : String(index).padStart(id.startsWith('step-') ? 2 : 1, '0');
      get(id).classList.toggle('complete', passed);
      get(id).classList.toggle('failed', check.state === 'failed');
    }
  }
}
