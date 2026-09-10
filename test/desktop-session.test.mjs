import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopSession } from '../desktop/main/session.mjs';
import { Bridge } from '../src/runtime/bridge.mjs';
import { ThreadStore } from '../src/thread-store.mjs';

const event = id => ({ id, type: 'player-message', player: '测试玩家', text: '测试', timestamp: new Date().toISOString(), metadata: {} });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'familiar-desktop-session-'));
  await mkdir(join(root, 'agents/dm'), { recursive: true }); await writeFile(join(root, 'agents/dm/AGENTS.md'), '测试 DM 规则');
  const config = { cwd: root, stateFile: join(root, 'data/state.json'), lockFile: join(root, 'data/bridge.lock'), instructionsFile: join(root, 'agents/dm/AGENTS.md'),
    familiarServer: 'familiar', queueLimit: 100, maxRestarts: 1, healthTimeoutMs: 1000, healthIntervalMs: 10000, turnTimeoutMs: 1000, shutdownTimeoutMs: 1000 };
  const trace = [], codex = new EventEmitter(); let current = 0, maximum = 0;
  Object.assign(codex, { familiarServer: 'familiar', start: async () => { codex.child = {}; codex.connection = { closed: false }; },
    stop: async () => { codex.child = null; codex.connection = { closed: true }; trace.push('codex:stop'); }, interruptActive: async () => {} });
  codex.startThread = async () => ({ thread: { id: 'desktop-thread' }, model: 'test-model', reasoningEffort: 'medium', sandbox: { type: 'readOnly' }, approvalPolicy: 'never' });
  codex.resumeThread = async id => ({ ...await codex.startThread(), thread: { id } });
  codex.runTurn = async (_id, _prompt, { eventId }) => {
    current++; maximum = Math.max(current, maximum); trace.push(`start:${eventId}`); await delay(5); current--; trace.push(`end:${eventId}`);
    return { turn: { id: `turn:${eventId}` }, items: ['get-world-info', 'send-chat-message'].map(tool => ({ type: 'mcpToolCall', server: 'familiar', tool, status: 'completed' })) };
  };
  const health = { read: async () => ({ world: { id: 'world', name: '测试世界' } }) };
  class BridgeClass extends Bridge { constructor(options, logger) { super(options, logger, { codex, health: () => health.read() }); } }
  class SourceClass extends EventEmitter {
    async start() { trace.push('source:start'); if (this.constructor.fail) throw new Error('端口已占用'); }
    async stop() { trace.push('source:stop'); }
  }
  const logger = Object.fromEntries(['info', 'debug', 'warn', 'error'].map(name => [name, () => {}]));
  const session = new DesktopSession(config, logger, () => {}, { BridgeClass, SourceClass, readPairing: async () => ({ worldId: 'world' }) });
  t.after(async () => { await session.stop(); await rm(root, { recursive: true, force: true }); });
  return { session, config, trace, codex, SourceClass, health, maximum: () => maximum };
}

test('桌面先完成监听再处理已保存的队列，所有 Turn 仍串行', async t => {
  const f = await fixture(t), store = new ThreadStore(f.config.stateFile);
  await store.load(); await store.enqueue(event('A')); await store.enqueue(event('B'));
  await f.session.start();
  await f.session.bridge.accept(event('C')); await f.session.bridge.drain();
  assert.ok(f.trace.indexOf('source:start') < f.trace.indexOf('start:A'));
  assert.deepEqual(f.trace.filter(value => /^(?:start|end):/.test(value)), ['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C']);
  assert.equal(f.maximum(), 1); assert.equal(f.session.status().phase, 'running');
  await f.session.stop(); assert.equal(f.codex.child, null); assert.equal(f.session.phase, 'stopped');
});

test('连接尚未完成就停止时不消费旧消息、不启动监听，保留待办', async t => {
  const f = await fixture(t), store = new ThreadStore(f.config.stateFile);
  await store.load(); await store.enqueue(event('A'));
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.health.read = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const starting = f.session.start(); await waiting;
  const stopping = f.session.stop(); assert.equal(f.session.phase, 'stopping');
  release({ world: { id: 'world', name: '世界' } });
  await Promise.all([starting, stopping]);
  assert.ok(!f.trace.includes('source:start')); assert.ok(!f.trace.includes('start:A'));
  assert.deepEqual(JSON.parse(await readFile(f.config.stateFile)).queued.map(item => item.id), ['A']);
  assert.equal(f.codex.child, null);
});

test('监听失败时清理 Codex，不开始游戏 Turn；只读检查不激活玩家队列', async t => {
  const f = await fixture(t), store = new ThreadStore(f.config.stateFile);
  await store.load(); await store.enqueue(event('A')); f.SourceClass.fail = true;
  await assert.rejects(f.session.start(), /端口/);
  assert.equal(f.codex.child, null); assert.ok(!f.trace.includes('start:A'));
  await f.session.start({ mode: 'manual', inspectionOnly: true });
  assert.equal(f.session.bridge.config.readOnlyProbe, true);
  assert.equal(f.session.bridge.queue.paused, true); assert.ok(!f.session.activated);
  assert.equal(f.session.bridge.store.snapshot().queued.length, 1);
});
