import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../desktop/renderer/render.mjs';

test('控制台直接展示暂停原因，保留恢复入口，就绪后移除旧提示', t => {
  const previous = { document: globalThis.document, bridge: globalThis.bridge };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', classList: { toggle() {} }, querySelector: () => element(`${id} span`) });
    return elements.get(id);
  };
  globalThis.document = { getElementById: element, querySelectorAll: () => [] };
  globalThis.bridge = { preview: false };
  const state = { status: { phase: 'paused', pauseReason: '对话被占用；释放后点击“恢复连接”。' },
    profile: { values: {}, directory: '/test', root: '/test' }, logs: [], paths: {} };
  render(state);
  assert.equal(element('service-hint').textContent, state.status.pauseReason);
  assert.equal(element('recover').disabled, false);
  assert.equal(element('start').disabled, true);
  state.status.pauseReason = null;
  render(state);
  assert.match(element('service-hint').textContent, /队列已暂停/);
  state.status = { phase: 'running', healthy: true, pauseReason: null };
  render(state);
  assert.match(element('service-hint').textContent, /已就绪/);
  assert.equal(element('recover').disabled, true);
});
