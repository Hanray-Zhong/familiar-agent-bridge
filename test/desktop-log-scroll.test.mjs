import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../desktop/renderer/render.mjs';

function fixture(t) {
  const previous = Object.fromEntries(['document', 'bridge', 'window', 'Option'].map(key => [key, globalThis[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, Object.assign(new EventTarget(), {
      id, textContent: '', value: '', hidden: false, dataset: {},
      attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name]; },
      focus() { globalThis.document.activeElement = this; },
      classList: { toggle() {}, add() {}, remove() {} },
      querySelector: () => element(`${id} span`), add() {}, append() {}, replaceChildren() {},
    }));
    return elements.get(id);
  };
  const pages = ['overview', 'connection', 'agent', 'rules', 'help'].map(page => element(`page-${page}`));
  const buttons = pages.map(page => {
    const button = element(`nav-${page.id}`); button.dataset.page = page.id.slice(5); return button;
  });
  const panel = element('log-card'), logs = element('logs');
  const responses = element('ai-responses'); responses.hidden = true;
  const logTabs = [['system-log-tab', 'logs'], ['ai-log-tab', 'ai-responses']].map(([id, target], index) => {
    const tab = element(id); tab.dataset.logTab = target; tab.tabIndex = index ? -1 : 0;
    tab.setAttribute('aria-selected', String(index === 0)); return tab;
  });
  panel.open = true;
  let textWrites = 0, windowScrolls = 0;
  // 模拟滚动范围钳制和隐藏元素零尺寸，确保只在布局可见后恢复滚动。
  for (const target of [logs, responses]) {
    let content = '', top = 0;
    const visible = () => panel.open && !element('page-overview').hidden && !target.hidden;
    Object.defineProperties(target, {
      textContent: { get: () => content, set: value => { content = value; if (target === logs) textWrites++; top = Math.min(top, target.scrollHeight - target.clientHeight); } },
      clientHeight: { get: () => visible() ? Math.min(260, content.split('\n').length * 18) : 0 },
      scrollHeight: { get: () => visible() ? content.split('\n').length * 18 : 0 },
      scrollTop: { get: () => visible() ? top : 0, set: value => { top = Math.max(0, Math.min(value, target.scrollHeight - target.clientHeight)); } },
    });
  }
  const state = { status: { phase: 'running', healthy: true }, profile: { values: {}, fields: [], directory: '/test', root: '/test' },
    logs: [], aiResponses: [], paths: {}, models: [], threads: [] };
  let onChange;
  globalThis.document = {
    getElementById: element, createElement: () => element('created'), querySelector: selector => selector === '.log-card' ? panel : null,
    querySelectorAll: selector => selector === '.page' ? pages : ['[data-page]', '.nav-item'].includes(selector) ? buttons : selector === '[data-log-tab]' ? logTabs : [],
  };
  globalThis.bridge = { preview: false, snapshot: async () => structuredClone(state), onChange: callback => { onChange = callback; } };
  globalThis.window = { scrollTo: () => { windowScrolls++; } };
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  return { state, logs, responses, element, get textWrites() { return textWrites; }, get windowScrolls() { return windowScrolls; },
    toggle(open) { panel.open = open; panel.dispatchEvent(new Event('toggle')); },
    navigate(page) { element(`nav-page-${page}`).dispatchEvent(new Event('click')); },
    selectTab(id) { element(id).dispatchEvent(new Event('click')); },
    async refresh() { onChange(); await new Promise(resolve => setImmediate(resolve)); },
  };
}

let appImports = 0;
const loadApp = () => import(`../desktop/renderer/app.mjs?log-tabs-test=${++appImports}`);
const lines = (count, start = 0) => Array.from({ length: count }, (_, i) => ({ id: String(start + i), text: `日志 ${start + i}` }));
function assertBottom(logs) {
  assert.ok(logs.scrollHeight > logs.clientHeight, '日志必须溢出，才能验证滚动');
  assert.equal(logs.scrollTop, logs.scrollHeight - logs.clientHeight);
}

test('新增日志和多行日志渲染后自动显示底部，只滚动日志区域', t => {
  const view = fixture(t);
  render(view.state);
  assert.match(view.logs.textContent, /启动或检查连接后/);
  assert.equal(view.logs.scrollTop, 0);
  view.state.logs = lines(40);
  render(view.state);
  assertBottom(view.logs);
  const previousTop = view.logs.scrollTop;
  view.state.logs.push({ id: 'next', text: '最新日志\n附加详情' });
  render(view.state);
  assertBottom(view.logs);
  assert.ok(view.logs.scrollTop > previousTop);
  assert.ok(view.logs.textContent.endsWith('最新日志\n附加详情'));
  assert.equal(view.windowScrolls, 0);
});

test('没有新日志的状态刷新保留手动阅读位置和日志文本节点', t => {
  const view = fixture(t);
  view.state.logs = lines(40);
  render(view.state);
  view.logs.scrollTop = 72;
  const writes = view.textWrites;
  view.state.status.queued = 3;
  render(structuredClone(view.state));
  assert.equal(view.logs.scrollTop, 72);
  assert.equal(view.textWrites, writes);
});

test('达到 300 条后淘汰旧日志仍自动滚动到最新记录', t => {
  const view = fixture(t);
  view.state.logs = lines(300);
  render(view.state);
  view.logs.scrollTop = 72;
  const height = view.logs.scrollHeight;
  view.state.logs = lines(300, 1);
  render(view.state);
  assert.equal(view.logs.scrollHeight, height);
  assert.ok(view.logs.textContent.startsWith('日志 1\n'));
  assert.ok(view.logs.textContent.endsWith('日志 300'));
  assertBottom(view.logs);
});

test('隐藏期间到达的日志在展开或切回控制台后显示底部', async t => {
  const view = fixture(t);
  view.toggle(false);
  await loadApp();
  view.state.logs = lines(40);
  await view.refresh();
  assert.equal(view.logs.scrollTop, 0);
  view.toggle(true);
  assertBottom(view.logs);
  view.logs.scrollTop = 72;
  view.toggle(false);
  view.state.logs.push({ id: 'collapsed', text: '折叠期间的新日志' });
  await view.refresh();
  view.toggle(true);
  assertBottom(view.logs);
  view.navigate('connection');
  assert.equal(view.element('page-overview').hidden, true);
  view.state.logs.push({ id: 'hidden-page', text: '其他页面期间的新日志' });
  await view.refresh();
  assert.equal(view.logs.scrollTop, 0);
  view.navigate('overview');
  assert.equal(view.element('page-overview').hidden, false);
  assertBottom(view.logs);
  assert.ok(view.logs.textContent.endsWith('其他页面期间的新日志'));
});

test('标签切换分别显示系统日志和真实回答，更新不改变所选标签或另一页阅读位置', async t => {
  const view = fixture(t);
  await loadApp();
  assert.match(view.responses.textContent, /实际回答会显示在这里/);
  view.state.logs = lines(40);
  view.state.aiResponses = [{ id: 'reply', timestamp: '2026-09-11T00:00:00.000Z', player: 'Alice', source: 'codex', text: lines(40).map(row => row.text).join('\n') },
    { id: 'chat', timestamp: '2026-09-11T00:00:01.000Z', player: 'Alice', source: 'foundry', text: '<img src="invalid" onerror="alert(1)">实际聊天' }];
  await view.refresh();
  assert.equal(view.responses.hidden, true);
  view.logs.scrollTop = 72;
  view.state.aiResponses[0].text += '\n补充回答';
  await view.refresh();
  assert.equal(view.logs.scrollTop, 72);
  view.selectTab('ai-log-tab');
  assert.equal(view.logs.hidden, true);
  assert.equal(view.responses.hidden, false);
  assert.equal(view.element('ai-log-tab').getAttribute('aria-selected'), 'true');
  assert.equal(view.element('system-log-tab').tabIndex, -1);
  assertBottom(view.responses);
  assert.match(view.responses.textContent, /Alice · Codex 回答/);
  assert.match(view.responses.textContent, /Foundry 聊天/);
  assert.ok(view.responses.textContent.includes('<img src="invalid" onerror="alert(1)">实际聊天'));
  assert.equal(view.logs.textContent.includes('实际聊天'), false);
  view.responses.scrollTop = 72;
  view.state.logs.push({ id: 'new', text: '系统更新' });
  await view.refresh();
  assert.equal(view.logs.hidden, true);
  assert.equal(view.responses.scrollTop, 72);
  view.state.aiResponses.push({ ...view.state.aiResponses[0], id: 'next', text: '新的完整回答' });
  await view.refresh();
  assertBottom(view.responses);
  view.selectTab('system-log-tab');
  assertBottom(view.logs);
  assert.equal(view.responses.hidden, true);
});

test('AI 回答页在折叠、导航后继续显示最新内容，标签支持键盘切换', async t => {
  const view = fixture(t);
  view.state.aiResponses = [{ id: 'reply', timestamp: '2026-09-11T00:00:00.000Z', player: 'Alice', source: 'codex', text: lines(40).map(row => row.text).join('\n') }];
  await loadApp();
  const press = (id, key) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key });
    view.element(id).dispatchEvent(event); return event;
  };
  assert.equal(press('system-log-tab', 'ArrowRight').defaultPrevented, true);
  assert.equal(document.activeElement, view.element('ai-log-tab'));
  assertBottom(view.responses);
  view.toggle(false);
  view.state.aiResponses[0].text += '\n折叠期间的回答';
  await view.refresh();
  view.toggle(true);
  assertBottom(view.responses);
  view.navigate('connection');
  view.state.aiResponses[0].text += '\n其他页面期间的回答';
  await view.refresh();
  view.navigate('overview');
  assertBottom(view.responses);
  assert.equal(view.logs.hidden, true);
  press('ai-log-tab', 'Home');
  assert.equal(view.logs.hidden, false);
  assert.equal(document.activeElement, view.element('system-log-tab'));
  press('system-log-tab', 'ArrowLeft');
  assert.equal(view.responses.hidden, false);
  press('ai-log-tab', 'Home');
  press('system-log-tab', 'End');
  assert.equal(view.responses.hidden, false);
  assert.equal(press('ai-log-tab', 'Tab').defaultPrevented, false);
});
