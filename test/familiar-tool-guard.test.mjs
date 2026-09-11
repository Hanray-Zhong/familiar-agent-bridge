import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameItemGuard, guardGameItem } from '../src/runtime/familiar-health.mjs';

const canvasError = 'Error: Canvas is not ready — scene may be loading or no scene is active';
const switched = { id: 'switch', type: 'mcpToolCall', server: 'familiar', tool: 'switch-scene', status: 'completed', readOnlyHint: false,
  result: { content: [{ type: 'text', text: '{"activated":true,"id":"scene-next","name":"测试场景"}' }] } };
const screenshot = { id: 'screenshot-1', type: 'mcpToolCall', server: 'familiar', tool: 'get-screenshot', status: 'failed', readOnlyHint: true,
  result: { isError: true, content: [{ type: 'text', text: canvasError }] } };
const completed = (guard, item) => guard(item, 'item/completed');
const client = () => {
  const warnings = [];
  return { familiarServer: 'familiar', warnings, logger: { warn: (...args) => warnings.push(args) } };
};

test('切场景已成功但画布未就绪时，仅保留一次只读截图恢复机会', () => {
  const codex = client(), guard = createGameItemGuard(codex);
  completed(guard, switched);
  assert.doesNotThrow(() => completed(guard, screenshot));
  assert.doesNotThrow(() => completed(guard, screenshot)); // 重复通知不算新工具调用。
  assert.equal(codex.warnings.length, 1);
  assert.equal(codex.warnings[0][2].sceneId, 'scene-next');
  assert.match(codex.warnings[0][2].action, /不要重复切换/);
  assert.throws(() => completed(guard, { ...screenshot, id: 'screenshot-2' }), { code: 'FAMILIAR_UNAVAILABLE' });
});

test('恢复机会不跨 Turn，未确认切场景成功或缺少只读声明时仍中断', () => {
  for (const previous of [null, { ...switched, result: { structuredContent: { activated: false } } },
    { ...switched, result: { structuredContent: { activated: true } } }, { ...switched, status: 'inProgress' }]) {
    const guard = createGameItemGuard(client());
    if (previous) completed(guard, previous);
    assert.throws(() => completed(guard, screenshot), { code: 'FAMILIAR_UNAVAILABLE' });
  }
  const codex = client(), guard = createGameItemGuard(codex);
  completed(guard, switched);
  assert.throws(() => completed(guard, { ...screenshot, readOnlyHint: false }), { code: 'FAMILIAR_UNAVAILABLE' });
  assert.throws(() => completed(createGameItemGuard(codex), screenshot), { code: 'FAMILIAR_UNAVAILABLE' });
  assert.throws(() => guardGameItem(codex, screenshot, 'item/completed'), { code: 'FAMILIAR_UNAVAILABLE' });
});

test('错误详情的文本和结构化表示均可识别；任何其他错误都不能借加载提示继续', () => {
  for (const item of [
    { ...screenshot, tool: 'get_screenshot', result: null, error: { message: canvasError } },
    { ...screenshot, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: canvasError }) }] } },
  ]) {
    const guard = createGameItemGuard(client()); completed(guard, switched);
    assert.doesNotThrow(() => completed(guard, item));
  }
  for (const item of [
    { ...screenshot, error: { message: 'transport closed' } },
    { ...screenshot, result: { ...screenshot.result, structuredContent: { connected: false } } },
    { ...screenshot, result: { isError: true, content: [...screenshot.result.content, { type: 'text', text: 'permission denied' }] } },
    { ...screenshot, result: { isError: true, content: [{ type: 'text', text: 'Screenshot unavailable' }] } },
    { ...screenshot, tool: 'move-token' },
  ]) {
    const guard = createGameItemGuard(client()); completed(guard, switched);
    assert.throws(() => completed(guard, item), { code: 'FAMILIAR_UNAVAILABLE' });
  }
  const guard = createGameItemGuard(client()); completed(guard, switched);
  assert.throws(() => completed(guard, { ...screenshot, server: 'other' }), { code: 'SECURITY_VIOLATION' });
  const disconnected = client(), guarded = createGameItemGuard(disconnected); completed(guarded, switched);
  disconnected.connection = { closed: true };
  assert.throws(() => completed(guarded, screenshot), { code: 'FAMILIAR_UNAVAILABLE' });
});

test('截图重试成功可继续其他工具；错误提示包含工具和脱敏原因，长度有上限', () => {
  const codex = client(), guard = createGameItemGuard(codex);
  completed(guard, switched); completed(guard, screenshot);
  assert.doesNotThrow(() => completed(guard, { ...screenshot, id: 'screenshot-2', status: 'completed', result: { content: [] } }));
  assert.doesNotThrow(() => completed(guard, { ...switched, tool: 'send-chat-message', result: { structuredContent: { success: true } } }));
  const failure = { ...screenshot, error: { message: '失败 https://example.com/private?token=secret-value\n' + 'x'.repeat(1000) }, result: null };
  assert.throws(() => completed(guard, failure), error => {
    assert.match(error.message, /get-screenshot.*失败.*URL REDACTED/);
    assert.ok(!error.message.includes('secret-value'));
    assert.ok(!error.message.includes('\n'));
    assert.ok(error.message.length < 500);
    return true;
  });
});
