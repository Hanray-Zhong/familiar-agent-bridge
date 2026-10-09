import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { render, renderGmConversation, renderReviews } from '../desktop/renderer/render.mjs';

test('待审核入口属于跑团控制台，不占用左侧一级导航', async () => {
  const html = await readFile(new URL('../desktop/renderer/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /class="nav-item" data-page="review"/);
  assert.match(html, /class="button review-entry" data-page="review">处理待审核/);
  assert.ok(html.indexOf('id="review-banner"') < html.indexOf('class="overview-grid"'));
  assert.match(html, /data-page="overview">← 返回跑团控制台/);
});

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

test('待审核界面优先选择未解决记录，以纯文本显示请求和 AI 对话', t => {
  const previous = globalThis.document;
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  class Element extends EventTarget {
    constructor() { super(); this.children = []; this.hidden = false; this.textContent = ''; this.classList = { toggle() {} }; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    get scrollHeight() { return this.children.length * 20; }
  }
  const elements = new Map(), element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  globalThis.document = { getElementById: element, createElement: () => new Element() };
  const state = { status: { phase: 'running', healthy: true }, busy: null, reviewIssues: [
    { id: 'resolved', at: '2026-01-02T00:00:00.000Z', resolvedAt: '2026-01-02T00:01:00.000Z', request: { player: 'Bob', text: '旧记录', timestamp: '2026-01-02T00:00:00.000Z' }, failure: null, messages: [] },
    { id: 'pending', at: '2026-01-01T00:00:00.000Z', resolvedAt: null, request: { player: 'Alice', text: '<img onerror="attack">检查箱子', timestamp: '2026-01-01T00:00:00.000Z' }, failure: { code: 'DISCONNECTED', message: '断线' }, messages: [
      { id: 'm1', role: 'assistant', text: '<b>只作为文本</b>', at: '2026-01-01T00:01:00.000Z' },
    ] },
  ] };
  let selected;
  assert.equal(renderReviews(state, null, id => { selected = id; }), 'pending');
  assert.equal(element('review-list').children[0].children[0].children[0].textContent, 'Alice');
  assert.match(element('review-request').textContent, /<img onerror="attack">检查箱子/);
  assert.equal(element('review-messages').children[0].children[1].textContent, '<b>只作为文本</b>');
  assert.equal(element('review-send').disabled, false);
  element('review-list').children[1].dispatchEvent(new Event('click'));
  assert.equal(selected, 'resolved');

  state.status.world = { name: '暮色边境' }; state.status.threadId = 'thread-1';
  state.gmMessages = [{ id: 'gm1', role: 'gm', text: '<script>只作为文字</script>', at: '2026-01-03T00:00:00.000Z' },
    { id: 'ai1', role: 'assistant', text: '场景已经重新布置。', at: '2026-01-03T00:01:00.000Z' }];
  renderGmConversation(state);
  assert.equal(element('gm-world').textContent, '暮色边境');
  assert.equal(element('gm-thread').textContent, 'thread-1');
  assert.equal(element('gm-messages').children[0].children[1].textContent, '<script>只作为文字</script>');
  assert.equal(element('gm-send').disabled, false);
});
