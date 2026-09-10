import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { JsonlConnection } from '../src/codex/jsonl-connection.mjs';
import { serverRequestReply } from '../src/codex/server-requests.mjs';

function connection(t, timeoutMs = 1000) {
  const input = new PassThrough();
  const output = new PassThrough();
  let sent = '';
  input.on('data', chunk => { sent += chunk; });
  const rpc = new JsonlConnection({ input, output, timeoutMs });
  t.after(() => { rpc.close(); input.destroy(); output.destroy(); });
  return { rpc, send: message => output.write(JSON.stringify(message) + '\n'), output,
    messages: () => sent.trim().split('\n').filter(Boolean).map(JSON.parse) };
}

test('response 按 id 关联，允许乱序', async t => {
  const { rpc, send } = connection(t);
  const first = rpc.request('a', {});
  const second = rpc.request('b', {});
  send({ id: 2, result: 'second' });
  send({ id: 1, result: 'first' });
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
});

test('server request 与 response 相同 id 不相互吞掉', async t => {
  const { rpc, send, messages } = connection(t);
  const pending = rpc.request('thread/start', {});
  send({ method: 'item/commandExecution/requestApproval', id: 1, params: { command: 'sensitive' } });
  send({ id: 1, result: { thread: { id: 'thread-a' } } });
  assert.equal((await pending).thread.id, 'thread-a');
  assert.deepEqual(messages()[1], { id: 1, result: { decision: 'decline' } });
});

test('JSONL 支持分块、notification 与迟到 response', async t => {
  const { rpc, output } = connection(t);
  const events = [];
  rpc.on('notification', event => events.push(event));
  output.write('{"method":"turn/');
  output.write('completed","params":{}}\n{"id":999,"result":{}}\n');
  assert.equal(events[0].method, 'turn/completed');
  assert.equal(rpc.closed, false);
});

test('坏 JSON 关闭连接且 reject 所有等待者，不回显原始内容', async t => {
  const { rpc, output } = connection(t);
  const pending = rpc.request('x', {});
  output.write('secret-invalid-json\n');
  await assert.rejects(pending, /无效 JSON/);
  assert.equal(rpc.pending.size, 0);
});

test('request 超时清理关联表，服务错误保留错误码', async t => {
  const { rpc, send } = connection(t, 10);
  await assert.rejects(rpc.request('x', {}), { code: 'REQUEST_TIMEOUT' });
  const pending = rpc.request('y', {});
  send({ id: 2, error: { code: -32601, message: 'unknown method' } });
  await assert.rejects(pending, { code: -32601 });
  assert.equal(rpc.pending.size, 0);
});

test('当前协议所有审批类型默认安全拒绝', () => {
  assert.deepEqual(serverRequestReply('item/permissions/requestApproval').result, { permissions: {}, scope: 'turn' });
  assert.equal(serverRequestReply('mcpServer/elicitation/request').result.action, 'decline');
  assert.equal(serverRequestReply('item/fileChange/requestApproval').result.decision, 'decline');
  assert.ok(serverRequestReply('execCommandApproval').result.decision.denied.rejection);
  assert.deepEqual(serverRequestReply('item/tool/requestUserInput').result.answers, {});
  assert.equal(serverRequestReply('item/tool/call').result.success, false);
  assert.equal(serverRequestReply('unknown').error.code, -32601);
});
