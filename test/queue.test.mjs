import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { TurnQueue, RetryLater } from '../src/turn-queue.mjs';

test('快速提交 A/B/C 仅一个 Turn 运行，B 失败不影响 C', async () => {
  let active = 0, maximum = 0;
  const trace = [];
  const queue = new TurnQueue(async ({ id }) => {
    active++;
    maximum = Math.max(maximum, active);
    trace.push(`start:${id}`);
    await delay(5);
    trace.push(`end:${id}`);
    active--;
    if (id === 'B') throw new Error('失败');
    return id;
  });
  queue.resume();
  const results = await Promise.allSettled(['A', 'B', 'C'].map(id => queue.enqueue({ id })));
  await queue.close();
  assert.equal(maximum, 1);
  assert.deepEqual(trace, ['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C']);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled']);
});

test('Familiar 不可用暂停并保留队首，恢复后继续', async () => {
  let ready = false;
  const calls = [];
  const queue = new TurnQueue(async ({ id }) => {
    if (!ready) throw new RetryLater('offline');
    calls.push(id);
  });
  const done = Promise.all(['A', 'B'].map(id => queue.enqueue({ id })));
  queue.resume();
  await delay(5);
  assert.equal(queue.paused, true);
  assert.equal(queue.waiting.length, 2);
  ready = true;
  queue.resume();
  await done;
  await queue.close();
  assert.deepEqual(calls, ['A', 'B']);
});

test('重复 ID 合并，关闭时拒绝未运行消息并等待当前任务', async () => {
  let finish;
  const queue = new TurnQueue(() => new Promise(resolve => { finish = resolve; }));
  const a = queue.enqueue({ id: 'A' });
  assert.equal(queue.enqueue({ id: 'A' }), a);
  queue.resume();
  const b = queue.enqueue({ id: 'B' });
  const rejected = assert.rejects(b, { code: 'QUEUE_CLOSED' });
  const closing = queue.close({ drain: false });
  finish();
  await Promise.all([a, rejected, closing]);
  assert.equal(queue.jobs.size, 0);
  await assert.rejects(queue.enqueue({ id: 'C' }), /已关闭/);
});
