import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../src/runtime/bridge.mjs';
import { FamiliarUnavailable } from '../src/runtime/familiar-health.mjs';
import { runTurn } from '../src/codex/turn-runner.mjs';

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

test('玩家 Turn 的真实回答发布到桌面事件，忽略旧回合并合并逐项通知与完成汇总', async t => {
  const { bridge, codex } = await setup(t);
  const responses = [];
  bridge.on('response', response => responses.push(response));
  await bridge.start();
  const chat = { type: 'mcpToolCall', id: 'chat', server: 'familiar', tool: 'send-chat-message', status: 'completed',
    arguments: { content: '你听见门外有脚步声。\n你打算怎么做？' }, result: { structuredContent: { success: true } } };
  const answer = { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '已完成观察，等待玩家行动。' };
  const world = { ...chat, id: 'world', tool: 'get-world-info', arguments: {} };
  codex.runTurn = (...args) => runTurn(codex, ...args);
  codex.requestTimeoutMs = 100;
  codex.request = async () => {
    const emit = (method, params) => codex.emit('notification', { method, params: { threadId: bridge.threadId, ...params } });
    emit('item/completed', { turnId: 'old-turn', item: { ...answer, id: 'old', text: '旧回答' } });
    emit('item/completed', { threadId: 'other-thread', turnId: 'turn', item: { ...answer, id: 'other', text: '其他对话' } });
    for (const item of [world, chat, answer]) emit('item/completed', { turnId: 'turn', item });
    emit('item/completed', { turnId: 'turn', item: answer });
    emit('turn/completed', { turn: { id: 'turn', status: 'completed', items: [chat, answer] } });
    return { turn: { id: 'turn' } };
  };
  await bridge.accept(event('A')); await bridge.drain();
  assert.deepEqual(responses.map(response => [response.source, response.text]), [['foundry', chat.arguments.content], ['codex', answer.text]]);
  assert.ok(responses.every(response => response.eventId === 'A' && response.threadId === bridge.threadId && response.player === 'Alice'));
  assert.equal(bridge.store.snapshot().receipts[0].status, 'processed');
});

test('Turn 后续失败仍保留已经收到的完整回答，回答事件不将失败请求标为完成', async t => {
  const { bridge, codex } = await setup(t);
  const responses = [];
  bridge.on('response', response => responses.push(response));
  await bridge.start();
  codex.runTurn = async (_thread, _prompt, { onItem }) => {
    onItem({ type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '已经读到的回答' }, 'item/completed');
    throw new Error('后续回合失败');
  };
  await bridge.accept(event('A')); await bridge.drain();
  assert.equal(responses[0].text, '已经读到的回答');
  assert.equal(bridge.store.snapshot().receipts[0].status, 'uncertain');
  assert.equal((await bridge.accept(event('A'))).accepted, false);
  assert.equal(responses.length, 1);
});

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

test('对话占用时保留待办并停止自动重启，释放后手工恢复同一对话且不重放不确定事件', async t => {
  const { bridge, codex } = await setup(t, { healthIntervalMs: 10 });
  await bridge.store.load();
  await bridge.store.saveThread('saved-thread');
  await bridge.store.enqueue(event('old'));
  await bridge.store.begin('old');
  await bridge.store.finish('old', 'uncertain');
  await bridge.store.enqueue(event('A'));
  const before = bridge.store.snapshot();
  let occupied = true;
  codex.startThread = async () => { assert.fail('不能新建替代对话'); };
  codex.resumeThread = async id => {
    codex.resumes++; codex.resumedId = id;
    if (occupied) throw Object.assign(new Error('对话被占用；请释放后恢复连接'), { code: 'THREAD_IN_USE' });
    return { thread: { id }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never' };
  };
  await bridge.start();
  await delay(35);
  await bridge.recover();
  assert.equal(bridge.manualPause, true);
  assert.equal(bridge.queue.paused, true);
  assert.equal(bridge.status().pauseReason, '对话被占用；请释放后恢复连接');
  assert.equal(codex.starts, 1);
  assert.equal(codex.child, null);
  assert.deepEqual(codex.trace, []);
  assert.deepEqual(bridge.store.snapshot(), before);

  await bridge.recover({ manual: true }); // 占用尚未解除，再次尝试仍保留待办。
  assert.equal(bridge.manualPause, true);
  assert.equal(codex.starts, 2);
  assert.deepEqual(bridge.store.snapshot(), before);
  occupied = false;
  await bridge.recover({ manual: true });
  await bridge.drain();
  assert.equal(codex.resumedId, 'saved-thread');
  assert.equal(codex.resumes, 3);
  assert.equal(bridge.status().healthy, true);
  assert.equal(bridge.status().pauseReason, null);
  assert.equal(bridge.store.snapshot().threadId, 'saved-thread');
  assert.deepEqual(codex.trace, ['start:A', 'end:A']);
  assert.deepEqual(bridge.store.snapshot().receipts.map(row => [row.id, row.status]), [['old', 'uncertain'], ['A', 'processed']]);
});

test('控制台暂停原因沿用脱敏规则，连接恢复后清除旧提示', async t => {
  const { bridge } = await setup(t);
  await bridge.start();
  bridge.pause('连接失败 https://example.com/private?token=secret-value');
  assert.equal(bridge.status().pauseReason, '连接失败 [URL REDACTED]');
  await bridge.recover();
  assert.equal(bridge.status().pauseReason, null);
});

test('移动后检定未通过仍能发送叙述、保存已处理回执且不会重复执行', async t => {
  const { bridge, codex } = await setup(t);
  const calls = [];
  const outcome = { success: false, roll: { total: 14, natural: 11, modifier: 3 }, dc: 15, ability: 'wis', skill: 'prc' };
  codex.runTurn = (threadId, prompt, options) => runTurn(codex, threadId, prompt, options);
  codex.request = async (method, params) => {
    calls.push(method);
    const notify = (method, detail) => codex.emit('notification', { method, params: { threadId: params.threadId, ...detail } });
    if (method === 'turn/interrupt') { notify('turn/completed', { turn: { id: 'turn-check', status: 'interrupted' } }); return {}; }
    assert.equal(method, 'turn/start');
    const results = [
      ['get-world-info', { world: { id: 'one', name: '测试世界' } }],
      ['move-token', { moved: true, x: 2200, y: 5700 }],
      ['resolve-ability-check', outcome],
      ['send-chat-message', { success: true }],
    ];
    for (const [tool, result] of results) {
      notify('item/completed', { turnId: 'turn-check', item: { id: tool, type: 'mcpToolCall', server: 'familiar', tool, status: 'completed',
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
    }
    notify('turn/completed', { turn: { id: 'turn-check', status: 'completed', items: [] } });
    return { turn: { id: 'turn-check' } };
  };
  await bridge.start();
  await bridge.accept(event('check'));
  await bridge.drain();
  assert.deepEqual(calls, ['turn/start']);
  assert.equal(bridge.status().healthy, true);
  assert.equal(bridge.status().paused, false);
  assert.equal(bridge.status().uncertain, 0);
  assert.equal(bridge.store.snapshot().lastProcessedMessageId, 'check');
  assert.equal(bridge.store.snapshot().receipts[0].status, 'processed');
  assert.equal((await bridge.accept(event('check'))).accepted, false);
  assert.deepEqual(calls, ['turn/start']);
});

for (const retryFails of [false, true]) test(`切场景后截图暂时失败，${retryFails ? '重试仍失败则暂停并保留不确定回执' : '重读场景及截图成功后继续完成'}，不重放场景切换`, async t => {
  const { bridge, codex } = await setup(t);
  const calls = [], tools = [];
  let interrupted = false;
  const canvasError = { isError: true, content: [{ type: 'text', text: 'Error: Canvas is not ready — scene may be loading or no scene is active' }] };
  const emit = (method, detail) => codex.emit('notification', { method, params: { threadId: 'persistent-thread', ...detail } });
  const item = (id, tool, result, status = 'completed', readOnlyHint = true) => {
    if (interrupted) return;
    tools.push(tool);
    emit('item/completed', { turnId: 'turn-scene', item: { id, type: 'mcpToolCall', server: 'familiar', tool, result, status, readOnlyHint } });
  };
  codex.runTurn = (threadId, prompt, options) => runTurn(codex, threadId, prompt, options);
  codex.request = async method => {
    calls.push(method);
    if (method === 'turn/interrupt') {
      interrupted = true;
      emit('turn/completed', { turn: { id: 'turn-scene', status: 'interrupted', items: [] } });
      return {};
    }
    assert.equal(method, 'turn/start');
    setImmediate(() => {
      item('world', 'get-world-info', { structuredContent: { world: { id: 'one', name: '测试世界' } } });
      item('switch', 'switch-scene', { structuredContent: { activated: true, id: 'scene-next' } }, 'completed', false);
      item('shot-1', 'get-screenshot', canvasError, 'failed');
      item('scene', 'get-current-scene', { structuredContent: { id: 'scene-next' } });
      item('shot-2', 'get-screenshot', retryFails ? canvasError : { content: [] }, retryFails ? 'failed' : 'completed');
      item('chat', 'send-chat-message', { structuredContent: { success: true } }, 'completed', false);
      if (!interrupted) emit('turn/completed', { turn: { id: 'turn-scene', status: 'completed', items: [] } });
    });
    return { turn: { id: 'turn-scene' } };
  };
  await bridge.start();
  await bridge.accept(event('scene'));
  await bridge.queue.idle();
  assert.deepEqual(calls, retryFails ? ['turn/start', 'turn/interrupt'] : ['turn/start']);
  assert.equal(tools.filter(tool => tool === 'switch-scene').length, 1);
  assert.equal(tools.filter(tool => tool === 'get-screenshot').length, 2);
  assert.equal(tools.includes('send-chat-message'), !retryFails);
  assert.equal(bridge.status().paused, retryFails);
  assert.equal(bridge.status().uncertain, retryFails ? 1 : 0);
  assert.equal(bridge.store.snapshot().receipts[0].status, retryFails ? 'uncertain' : 'processed');
  if (retryFails) assert.match(bridge.status().pauseReason, /get-screenshot.*Canvas is not ready/);
  assert.equal((await bridge.accept(event('scene'))).accepted, false);
  assert.equal(tools.filter(tool => tool === 'switch-scene').length, 1);
});
