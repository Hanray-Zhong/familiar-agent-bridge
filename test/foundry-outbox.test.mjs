import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Outbox, emptyOutbox } from '../foundry-module/relay/outbox.mjs';
import { RelayController } from '../foundry-module/relay/controller.mjs';
import { ROUTES } from '../foundry-module/shared/protocol.mjs';
import { pairing, gameFixture, message, FakeLocks } from './helpers/foundry.mjs';

test('离线保留队首，重载后按顺序发送；ACK 与完成状态分开', async () => {
  let saved = emptyOutbox(), ready = false, time = 1;
  const sent = [];
  const options = { read: () => saved, write: async value => { saved = structuredClone(value); }, clock: () => time,
    post: async (path, body) => {
      if (path === ROUTES.status) return { receipts: body.ids.map(id => ({ id, status: 'processed' })) };
      if (!ready) throw Object.assign(new Error('offline'), { retryable: true });
      sent.push(body.event.id);
      return { id: body.event.id, status: 'queued' };
    } };
  const first = new Outbox(options);
  await first.load();
  for (const id of ['A', 'B']) await first.observe({ id, timestamp: new Date().toISOString() }, 1);
  await first.pump();
  assert.equal(saved.pending.length, 2);
  await first.stop();
  const reloaded = new Outbox(options);
  await reloaded.load();
  ready = true; time = 100000;
  await reloaded.pump();
  await reloaded.pump();
  assert.deepEqual(sent, ['A', 'B']);
  assert.equal(saved.pending.length, 0);
  assert.equal(saved.watching.length, 1);
  time += 20000;
  await reloaded.pump();
  assert.equal(saved.watching.length, 0);
  await reloaded.stop();
});

test('认证失败立即暂停，网络失败有重试上限，人工 retry 保留原 ID', async () => {
  let time = 1, attempts = 0, saved = emptyOutbox();
  const box = new Outbox({ read: () => saved, write: async state => { saved = state; }, clock: () => time,
    post: async () => { attempts++; throw Object.assign(new Error('offline'), { retryable: true }); } });
  await box.load();
  await box.observe({ id: 'A', timestamp: new Date().toISOString() }, 1);
  for (let i = 0; i < 10; i++) { time += 120000; await box.pump(); }
  assert.equal(attempts, 8);
  assert.equal(saved.blocked, true);
  await box.retry();
  assert.equal(saved.pending[0].event.id, 'A');
  box.post = async () => { throw Object.assign(new Error('401'), { retryable: false }); };
  await box.pump();
  assert.equal(saved.blocked, true);
  await box.stop();
});

test('发送成功但本地 ACK 落盘失败时，保留原始事件以便服务端去重', async () => {
  let saved = emptyOutbox(), failing = false;
  const box = new Outbox({ read: () => saved,
    write: async state => { if (failing) throw new Error('storage full'); saved = state; },
    post: async (_path, body) => { failing = true; return { id: body.event.id, status: 'queued' }; } });
  await box.load();
  await box.observe({ id: 'A', timestamp: new Date().toISOString() }, 1);
  await assert.rejects(box.pump(), /storage full/);
  assert.equal(saved.pending[0].event.id, 'A');
  assert.equal(saved.watching.length, 0);
  await box.stop();
});

test('两个同 GM 标签页只允许一个持锁推送，关闭后另一标签页可接管', async () => {
  const p = await pairing(), game = gameFixture(p), locks = new FakeLocks();
  game.messages.contents = [message(game)];
  const posts = [];
  const options = { game, locks, notify: () => {}, textOf: doc => doc.content,
    post: async (_pair, path, body) => {
      if (path === ROUTES.status) return { receipts: body.ids.map(id => ({ id, status: 'processed' })) };
      posts.push(body.event.id); return { id: body.event.id, status: 'queued' };
    } };
  const a = new RelayController(options), b = new RelayController(options);
  const first = a.tick();
  await delay(5);
  await b.tick();
  assert.equal(a.owner, true);
  assert.equal(b.owner, false);
  assert.deepEqual(posts, ['world:msg1']);
  await a.stop(); await first;
  const second = b.tick(); await delay(5);
  assert.equal(b.owner, true);
  assert.deepEqual(posts, ['world:msg1']);
  await b.stop(); await second;
  assert.equal(locks.held.size, 0);
});

test('浏览器 ACK 不确定状态不自动重投', async () => {
  let saved = emptyOutbox(), posts = 0;
  const box = new Outbox({ read: () => saved, write: async state => { saved = state; },
    post: async (_path, body) => { posts++; return { id: body.event.id, status: 'uncertain' }; } });
  await box.load(); await box.observe({ id: 'A', timestamp: new Date().toISOString() }, 1);
  await box.pump(); await box.pump();
  assert.equal(posts, 1);
  assert.deepEqual(saved.recent, ['A']);
  await box.stop();
});

test('队列满时保存补投缺口，后来的普通聊天不能掩盖漏收消息', async () => {
  let saved = emptyOutbox();
  const box = new Outbox({ maxPending: 1, read: () => saved, write: async state => { saved = state; },
    post: async (_path, body) => ({ id: body.event.id, status: 'processed' }) });
  await box.load();
  await box.observe({ id: 'A', timestamp: new Date(100).toISOString() }, 100);
  await assert.rejects(box.observe({ id: 'B', timestamp: new Date(200).toISOString() }, 200), { code: 'OUTBOX_FULL' });
  await box.observe(null, 50000);
  assert.equal(saved.gapSince, 200);
  const version = saved.gapVersion;
  await box.pump();
  await box.observe({ id: 'B', timestamp: new Date(200).toISOString() }, 200);
  await box.clearGap(version);
  assert.equal(saved.gapSince, null);
  assert.equal(saved.pending[0].event.id, 'B');
  await box.stop();
});
