import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionChecks } from '../desktop/main/connection-checks.mjs';
import { renderConnections } from '../desktop/renderer/connections.mjs';

function view(t) {
  const original = globalThis.document;
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { textContent: '', classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) } });
    }
    return elements.get(id);
  };
  globalThis.document = { getElementById: get };
  return get;
}

test('配对与监听均不能提前打勾，同一检查快照同步到控制台、准备步骤与设置页', t => {
  const get = view(t), checks = new ConnectionChecks();
  const state = { status: { phase: 'stopped', healthy: false }, pairing: { worldId: 'world' }, environment: { compatible: true } };
  renderConnections(state);
  assert.equal(get('check-cli').textContent, '1');
  assert.equal(get('check-pair').textContent, '2');
  assert.equal(get('check-push').textContent, '3');
  checks.set('codex', 'passed', 'Codex 已验证');
  checks.worldResult({ id: 'world', name: '测试世界' }, true);
  state.connections = checks.snapshot(); renderConnections(state);
  assert.equal(get('check-cli').textContent, '✓');
  assert.equal(get('check-pair').textContent, '✓');
  assert.equal(get('step-world').textContent, '✓');
  assert.match(get('world-state').textContent, /上次测试通过/);
  assert.equal(get('world-state').textContent, get('connection-world-result').textContent);
  assert.equal(get('world-state').textContent, get('setup-world-result').textContent);
  checks.set('world', 'failed', '连接中断');
  state.connections = checks.snapshot(); renderConnections(state);
  assert.equal(get('check-pair').textContent, '!');
  assert.equal(get('world-dot').classList.contains('ok'), false);
  assert.match(get('connection-world-result').textContent, /未通过 · 连接中断/);
  checks.reset(['world']); state.connections = checks.snapshot(); renderConnections(state);
  assert.equal(get('check-pair').textContent, '2');
});

test('运行健康状态与签名推送凭据独立，暂停及手工模式不保留错误世界状态', () => {
  const checks = new ConnectionChecks();
  const status = { phase: 'running', mode: 'foundry', healthy: true, codexConnected: true, listening: true, world: { id: 'world', name: '世界' } };
  checks.observe(status);
  assert.equal(checks.world.state, 'passed');
  assert.equal(checks.push.state, 'untested');
  checks.observe({ ...status, relayVerifiedAt: new Date().toISOString() });
  assert.equal(checks.push.state, 'passed');
  const verified = checks.snapshot();
  checks.observe({ phase: 'stopped', healthy: false });
  assert.deepEqual(checks.snapshot(), verified);
  checks.observe({ ...status, phase: 'paused', healthy: false, codexConnected: false, pauseReason: 'Codex 已断开' });
  assert.equal(checks.codex.state, 'failed');
  assert.equal(checks.world.state, 'failed');
  checks.observe({ ...status, mode: 'manual', listening: false });
  assert.equal(checks.world.state, 'untested');
  assert.match(checks.world.message, /保存配对/);
});
