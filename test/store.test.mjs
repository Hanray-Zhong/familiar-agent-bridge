import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { ThreadStore } from '../src/thread-store.mjs';
import { acquireLock } from '../src/storage/instance-lock.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const store = new ThreadStore(file);
  await store.load();
  return { store, file, dir };
}

test('原子存储：并发入队、持久化 Thread、完成去重、重启保留排队事件', async t => {
  const { store, file } = await setup(t);
  await store.saveThread('thread-1');
  await Promise.all(['A', 'B', 'C'].map(id => store.enqueue({ id, text: id })));
  await store.begin('A');
  await store.finish('A', 'processed', 'turn-1');
  const next = new ThreadStore(file);
  const state = await next.load();
  assert.equal(state.threadId, 'thread-1');
  assert.equal(state.lastProcessedMessageId, 'A');
  assert.equal(await next.enqueue({ id: 'A', text: 'duplicate' }), false);
  assert.deepEqual(state.queued.map(event => event.id), ['B', 'C']);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('崩溃中的事件标记 uncertain，拒绝自动重放', async t => {
  const { store, file } = await setup(t);
  await store.enqueue({ id: 'A', text: '骰子可能已掷出' });
  await store.begin('A');
  const next = new ThreadStore(file);
  const state = await next.load();
  assert.equal(state.inFlight, null);
  assert.equal(state.receipts[0].status, 'uncertain');
  assert.equal(await next.enqueue({ id: 'A', text: 'again' }), false);
});

test('坏 JSON 不覆盖；World 切换不复用旧 Thread；重置保留去重', async t => {
  const { store, file } = await setup(t);
  await store.bindWorld({ id: 'one', name: '一' });
  await assert.rejects(store.bindWorld({ id: 'two', name: '二' }), { code: 'WORLD_CHANGED' });
  await store.enqueue({ id: 'A', text: '等待' });
  await store.reset();
  assert.equal(await store.enqueue({ id: 'A', text: '旧 Session 重投' }), false);
  await writeFile(file, 'broken');
  await assert.rejects(new ThreadStore(file).load(), /无法读取/);
  assert.equal(await readFile(file, 'utf8'), 'broken');
});

test('实例锁拒绝同目录并发启动，释放后可重启', async t => {
  const { dir } = await setup(t);
  const file = join(dir, 'bridge.lock');
  const release = await acquireLock(file);
  await release.setRuntimePid(process.pid);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).runtimePid, process.pid);
  await assert.rejects(acquireLock(file), /占用/);
  await release();
  await (await acquireLock(file))();
});

test('Bridge 已退出但旧 App Server 仍存活时，不能回收锁', async t => {
  const { dir } = await setup(t);
  const file = join(dir, 'bridge.lock');
  await writeFile(file, JSON.stringify({ pid: 2147483647, host: hostname(), runtimePid: process.pid }));
  await assert.rejects(acquireLock(file), /App Server 仍可能运行/);
});

test('普通事件特殊 ID 不污染 Foundry 回执对象的原型', async t => {
  const { store } = await setup(t);
  await store.enqueue({ id: '__proto__', text: 'test' });
  await store.begin('__proto__'); await store.finish('__proto__', 'processed');
  assert.equal(Object.prototype.status, undefined);
  assert.equal(store.foundryStatuses(['__proto__'])[0].status, 'unknown');
});
