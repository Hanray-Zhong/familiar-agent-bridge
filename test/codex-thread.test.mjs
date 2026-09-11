import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { CodexAppServer } from '../src/codex-app-server.mjs';
import { JsonlConnection } from '../src/codex/jsonl-connection.mjs';
import { threadOptions } from '../src/codex/policy.mjs';

test('恢复对话的真实 RPC 错误被识别为占用，并给出保留原对话的恢复办法', async t => {
  const input = new PassThrough(), output = new PassThrough();
  const client = new CodexAppServer();
  client.connection = new JsonlConnection({ input, output });
  t.after(() => { client.connection.close(); input.destroy(); output.destroy(); });
  const requests = [];
  input.on('data', data => {
    const request = JSON.parse(String(data)); requests.push(request);
    output.write(JSON.stringify({ id: request.id, error: { code: -32600,
      message: 'thread saved-thread already has an active writer' } }) + '\n');
  });
  await assert.rejects(client.resumeThread('saved-thread', threadOptions('/tmp', '长期指令')), error => {
    assert.equal(error.code, 'THREAD_IN_USE');
    assert.equal(error.threadId, 'saved-thread');
    assert.match(error.message, /saved-thread.*占用.*释放.*恢复连接/);
    assert.match(error.message, /完全退出/);
    assert.equal(error.cause.code, -32600);
    assert.equal(error.cause.message, 'thread/resume: thread saved-thread already has an active writer');
    return true;
  });
  assert.deepEqual(requests.map(request => request.method), ['thread/resume']);
  assert.equal(requests[0].params.threadId, 'saved-thread');
  assert.equal(requests[0].params.sandbox, 'read-only');
  assert.equal(requests[0].params.approvalPolicy, 'never');
});

test('其他恢复错误保留原始错误，不能误判为写入占用', async () => {
  const client = new CodexAppServer();
  for (const message of ['thread/resume: 对话不存在', 'App Server request 超时: thread/resume',
    'thread/resume: thread another-thread already has an active writer']) {
    const failure = Object.assign(new Error(message), { code: -32600 });
    client.request = async () => { throw failure; };
    await assert.rejects(client.resumeThread('saved-thread'), error => error === failure);
  }
});
