import test from 'node:test';
import assert from 'node:assert/strict';
import { createResponseCollector } from '../src/runtime/responses/collector.mjs';

const context = { event: { id: 'request', player: 'Alice' }, threadId: 'thread', familiarServer: 'familiar' };
const answer = (id, text, phase = 'final_answer') => ({ type: 'agentMessage', id, text, phase });
const chat = (overrides = {}) => ({ type: 'mcpToolCall', id: 'chat', server: 'familiar', tool: 'send-chat-message',
  status: 'completed', arguments: { content: '门外传来了脚步声。\n你打算怎么做？' }, result: { structuredContent: { success: true } }, ...overrides });

test('完整回答与成功聊天按来源收集，保留换行和长回答并脱敏', () => {
  const records = [], collect = createResponseCollector(context, row => records.push(row));
  const text = `第一段\n${'回答'.repeat(4000)}\nBearer abcdef\nhttps://example.invalid/private\ntoken=hidden`;
  collect(answer('final', text));
  collect(chat());
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(row => row.source), ['codex', 'foundry']);
  assert.ok(records[0].text.startsWith(`第一段\n${'回答'.repeat(4000)}\n`));
  assert.ok(!records[0].text.includes('abcdef'));
  assert.ok(!records[0].text.includes('example.invalid'));
  assert.ok(!records[0].text.includes('hidden'));
  assert.equal(records[1].text, chat().arguments.content);
  assert.equal(records[0].eventId, 'request');
  assert.equal(records[0].threadId, 'thread');
  assert.equal(records[0].player, 'Alice');
  assert.ok(Number.isFinite(Date.parse(records[0].timestamp)));
});

test('排除进行中、思考过程、进度说明、无效文本和失败或其他服务的聊天', () => {
  const records = [], collect = createResponseCollector(context, row => records.push(row));
  collect(answer('started', '尚未完成'), 'item/started');
  collect(answer('progress', '正在查询', 'commentary'));
  collect({ type: 'reasoning', id: 'reasoning', summary: ['内部推理'], content: ['内部推理'] });
  collect(answer('empty', '   '));
  collect(answer('invalid', null));
  collect(chat({ status: 'inProgress' }));
  collect(chat({ status: 'failed' }));
  collect(chat({ error: { message: '失败' } }));
  collect(chat({ result: null }));
  collect(chat({ result: { content: [{ type: 'text', text: '{"success":false}' }] } }));
  collect(chat({ result: { isError: true } }));
  collect(chat({ server: 'other' }));
  collect(chat({ tool: 'get-world-info' }));
  collect(chat({ arguments: { content: { text: '不是文本' } } }));
  assert.deepEqual(records, []);
});

test('重复完成通知不追加，兼容未标记阶段的回答和下划线工具名，每个请求独立去重', () => {
  const records = [], collect = createResponseCollector(context, row => records.push(row));
  const item = answer('same', '旧模型的回答', null);
  collect(item); collect(item);
  collect(chat({ tool: 'send_chat_message' }));
  collect(chat());
  assert.equal(records.length, 2);
  const next = createResponseCollector({ ...context, event: { id: 'next', player: 'Bob' } }, row => records.push(row));
  next(item);
  assert.equal(records[2].eventId, 'next');
  assert.equal(records[2].player, 'Bob');
});

test('异常长回答明确标记截断，不进入无限缓冲', () => {
  const records = [], collect = createResponseCollector(context, row => records.push(row));
  collect(answer('long', '字'.repeat(70000)));
  assert.ok(records[0].text.startsWith('字'.repeat(64000)));
  assert.ok(records[0].text.endsWith('[回答过长，已截断]'));
  assert.ok(records[0].text.length < 64100);
});
