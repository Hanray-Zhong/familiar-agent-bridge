import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { runTurn } from '../src/codex/turn-runner.mjs';

class Client extends EventEmitter {
  requestTimeoutMs = 100;
  stopped = false;
  async stop() { this.stopped = true; this.emit('disconnected'); }
  event(method, params) { this.emit('notification', { method, params: { threadId: 'thread', ...params } }); }
  completed(id = 'turn', status = 'completed') { this.event('turn/completed', { turn: { id, status, items: [] } }); }
}

test('turn/completed 先于 start response 时仍正确完成，忽略旧 Turn', async () => {
  const client = new Client();
  client.request = async () => {
    client.completed('old');
    client.event('item/completed', { turnId: 'turn', item: { type: 'agentMessage', id: 'item', text: '正常' } });
    client.completed();
    return { turn: { id: 'turn' } };
  };
  const result = await runTurn(client, 'thread', 'x');
  assert.equal(result.turn.id, 'turn');
  assert.equal(result.items[0].text, '正常');
  assert.equal(client.listenerCount('notification'), 0);
});

test('同一客户端拒绝并行 Turn，失败 Turn 完成后可以继续', async () => {
  const client = new Client();
  client.request = async () => ({ turn: { id: 'turn' } });
  const first = runTurn(client, 'thread', 'a');
  await delay(1);
  await assert.rejects(runTurn(client, 'thread', 'b'), /一个/);
  client.completed('turn', 'failed');
  await assert.rejects(first, { code: 'TURN_FAILED' });
  const next = runTurn(client, 'thread', 'c');
  client.completed();
  await next;
});

test('超时发送 interrupt 并等待 completed，期间不能开始下一 Turn', async () => {
  const client = new Client();
  let interrupted = false;
  client.request = async method => {
    if (method === 'turn/interrupt') {
      interrupted = true;
      await delay(15);
      client.completed('turn', 'interrupted');
      return {};
    }
    return { turn: { id: 'turn' } };
  };
  const current = runTurn(client, 'thread', 'a', { timeoutMs: 10, interruptTimeoutMs: 100 });
  const failure = assert.rejects(current, { code: 'TURN_TIMEOUT' });
  await delay(15);
  assert.equal(interrupted, true);
  await assert.rejects(runTurn(client, 'thread', 'b'), /一个/);
  await failure;
  assert.equal(client.stopped, false);
});

test('interrupt 无完成通知则关闭进程；连接中断 reject 当前 Turn', async () => {
  const client = new Client();
  client.request = async method => method === 'turn/start' ? { turn: { id: 'turn' } } : {};
  await assert.rejects(runTurn(client, 'thread', 'a', { timeoutMs: 5, interruptTimeoutMs: 10 }), { code: 'TURN_TIMEOUT' });
  assert.equal(client.stopped, true);
  assert.equal(client.activeTurn, null);
  const other = new Client();
  other.request = async () => ({ turn: { id: 'turn' } });
  const current = runTurn(other, 'thread', 'a');
  other.emit('disconnected');
  await assert.rejects(current, { code: 'DISCONNECTED' });
});

test('turn/start response 丢失时关闭进程，不盲目重试', async () => {
  const client = new Client();
  client.request = async () => { throw Object.assign(new Error('timeout'), { code: 'REQUEST_TIMEOUT' }); };
  await assert.rejects(runTurn(client, 'thread', 'a'));
  assert.equal(client.stopped, true);
  assert.equal(client.activeTurn, null);
});
