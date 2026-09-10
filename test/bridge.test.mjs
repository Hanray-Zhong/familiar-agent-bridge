import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../src/runtime/bridge.mjs';
import { FamiliarUnavailable } from '../src/runtime/familiar-health.mjs';

class FakeCodex extends EventEmitter {
  familiarServer = 'familiar';
  starts = 0; resumes = 0; active = 0; maximum = 0; trace = [];
  async start() {
    this.starts++;
    if (this.failStartup) throw new Error('启动失败');
    this.child = {};
    this.connection = { closed: false };
  }
  async stop() { this.child = null; this.connection = { closed: true }; }
  async startThread() { return { thread: { id: 'persistent-thread' }, model: 'test-model', reasoningEffort: 'high', sandbox: { type: 'readOnly' }, approvalPolicy: 'never' }; }
  async resumeThread(id) { this.resumes++; this.resumedId = id; return { ...await this.startThread(), thread: { id } }; }
  async interruptActive() { this.interrupted = true; }
  async runTurn(threadId, prompt, { eventId }) {
    this.active++;
    this.maximum = Math.max(this.maximum, this.active);
    this.trace.push(`start:${eventId}`);
    const connection = this.connection;
    await delay(10);
    this.active--;
    this.trace.push(`end:${eventId}`);
    if (connection.closed) throw Object.assign(new Error('disconnected'), { code: 'DISCONNECTED' });
    if (eventId === this.failId) throw new Error('单条 Turn 失败');
    return { turn: { id: `turn-${eventId}`, status: 'completed' }, items: ['get-world-info', 'send-chat-message'].map(tool => ({ type: 'mcpToolCall', server: 'familiar', tool, status: 'completed' })) };
  }
  crash() { this.connection.closed = true; this.emit('unavailable', new Error('App Server crashed')); }
}

async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-runtime-test-'));
  await writeFile(join(dir, 'AGENTS.md'), '测试指令');
  const config = { cwd: dir, instructionsFile: join(dir, 'AGENTS.md'), stateFile: join(dir, 'state.json'), lockFile: join(dir, 'bridge.lock'),
    familiarServer: 'familiar', queueLimit: 100, healthTimeoutMs: 100, turnTimeoutMs: 100, healthIntervalMs: 10000, shutdownTimeoutMs: 1000, maxRestarts: 1, ...overrides };
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(name => [name, () => {}]));
  const codex = new FakeCodex();
  const healthState = { ready: true, world: { id: 'one', name: '测试世界' } };
  const health = async () => {
    if (!healthState.ready) throw new FamiliarUnavailable('离线');
    return { world: healthState.world };
  };
  const bridge = new Bridge(config, logger, { codex, health });
  t.after(async () => { await bridge.stop(); await rm(dir, { recursive: true, force: true }); });
  return { bridge, codex, healthState };
}

const event = id => ({ id, player: 'Alice', text: '只读测试', type: 'player-message', timestamp: new Date().toISOString(), metadata: {} });

test('完整 Bridge 串行执行、单条失败继续、持久化成功与失败 ID 去重', async t => {
  const { bridge, codex } = await setup(t);
  await bridge.start();
  codex.failId = 'B';
  await Promise.all(['A', 'B', 'C'].map(id => bridge.accept(event(id))));
  await bridge.drain();
  assert.equal(codex.maximum, 1);
  assert.deepEqual(codex.trace, ['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C']);
  assert.deepEqual(bridge.store.snapshot().receipts.map(r => r.status), ['processed', 'uncertain', 'processed']);
  assert.equal((await bridge.accept(event('B'))).accepted, false);
});

test('离线时事件落盘但不调用 Agent，恢复后继续', async t => {
  const { bridge, codex, healthState } = await setup(t);
  healthState.ready = false;
  await bridge.start();
  await bridge.accept(event('A'));
  await delay(10);
  assert.equal(codex.trace.length, 0);
  assert.equal(bridge.store.snapshot().queued.length, 1);
  healthState.ready = true;
  await bridge.recover();
  await bridge.drain();
  assert.equal(bridge.store.snapshot().lastProcessedMessageId, 'A');
});

test('崩溃后恢复原 Thread，不重放结果不确定的当前事件', async t => {
  const { bridge, codex } = await setup(t, { healthIntervalMs: 20 });
  await bridge.start();
  await bridge.accept(event('A'));
  await bridge.accept(event('B'));
  while (!codex.active) await delay(1);
  codex.crash();
  await bridge.queue.idle();
  assert.equal(codex.starts, 2);
  assert.equal(codex.resumes, 1);
  assert.deepEqual(codex.trace, ['start:A', 'end:A', 'start:B', 'end:B']);
  assert.equal(bridge.store.snapshot().threadId, 'persistent-thread');
  assert.equal(bridge.store.snapshot().receipts[0].status, 'uncertain');
});

test('重启次数有上限；World 改变需要管理员干预', async t => {
  const { bridge, codex } = await setup(t);
  await bridge.start();
  codex.crash();
  codex.failStartup = true;
  await bridge.recover();
  await bridge.recover();
  assert.equal(bridge.manualPause, true);
  assert.equal(bridge.restarts, 1);
  const other = await setup(t);
  await other.bridge.start();
  other.healthState.world = { id: 'two', name: '其他世界' };
  await other.bridge.accept(event('A'));
  await delay(10);
  assert.equal(other.bridge.manualPause, true);
  assert.equal(other.codex.trace.length, 0);
});

test('doctor 不消费持久化玩家事件', async t => {
  const { bridge, codex } = await setup(t);
  await bridge.start({ inspectionOnly: true });
  await bridge.store.enqueue(event('待处理'));
  assert.equal(codex.trace.length, 0);
  assert.equal(bridge.queue.paused, true);
  assert.equal(bridge.store.snapshot().queued.length, 1);
});

test('关闭前已经接收但尚未落盘的事件仍被保存', async t => {
  const { bridge, codex } = await setup(t);
  await bridge.start();
  const accepted = bridge.accept(event('A'));
  const closing = bridge.stop();
  assert.equal((await accepted).accepted, true);
  await closing;
  assert.deepEqual(bridge.store.snapshot().queued.map(event => event.id), ['A']);
  assert.equal(codex.trace.length, 0);
});

test('指定已有对话会 resume 并持久化，重启继续该对话且状态显示实际 model/effort', async t => {
  const { bridge, codex } = await setup(t, { threadId: 'chosen-thread' });
  await bridge.start();
  assert.equal(codex.resumedId, 'chosen-thread');
  assert.equal(bridge.store.snapshot().threadId, 'chosen-thread');
  assert.equal(bridge.status().model, 'test-model');
  assert.equal(bridge.status().reasoningEffort, 'high');
  await bridge.accept(event('A'));
  await bridge.drain();
  codex.crash();
  await bridge.recover();
  assert.equal(codex.resumes, 2);
  assert.equal(codex.resumedId, 'chosen-thread');
  assert.equal(bridge.store.snapshot().lastProcessedMessageId, 'A');
});

test('指定对话与磁盘对话冲突时保留待办，不启动 Codex 或改绑', async t => {
  const { bridge, codex } = await setup(t, { threadId: 'chosen-thread' });
  await bridge.store.load();
  await bridge.store.saveThread('old-thread');
  await bridge.store.enqueue(event('A'));
  await assert.rejects(bridge.start(), /保存的对话不同/);
  assert.equal(codex.starts, 0);
  assert.equal(bridge.store.snapshot().threadId, 'old-thread');
  assert.deepEqual(bridge.store.snapshot().queued.map(item => item.id), ['A']);
});

test('resume 失败不会新建替代对话', async t => {
  const { bridge, codex } = await setup(t, { threadId: 'chosen-thread' });
  let newThreads = 0;
  codex.startThread = async () => { newThreads++; throw new Error('不应创建'); };
  codex.resumeThread = async () => { throw new Error('对话不存在'); };
  await bridge.start();
  assert.equal(newThreads, 0);
  assert.equal(bridge.store.snapshot().threadId, null);
  assert.equal(bridge.healthy, false);
  assert.equal(bridge.queue.paused, true);
});
