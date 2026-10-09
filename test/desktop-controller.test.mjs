import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopController } from '../desktop/main/controller.mjs';
import { ProfileStore } from '../desktop/main/profile-store.mjs';
import { projectRoot } from '../src/runtime/config.mjs';
import { ThreadStore } from '../src/thread-store.mjs';

async function fixture(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-desktop-controller-'));
  const profile = new ProfileStore(dir, projectRoot); await profile.load();
  const controller = new DesktopController(profile, options);
  t.after(async () => { await controller.shutdown(); await rm(dir, { recursive: true, force: true }); });
  return { controller, profile, config: await profile.config() };
}

test('桌面回答独立于系统日志级别并限制最近 100 条，停止后仍可查阅', async t => {
  class Session {
    constructor(_config, _logger, _changed, { onResponse }) { this.onResponse = onResponse; }
    async start() { this.phase = 'running'; }
    async stop() { this.phase = 'stopped'; }
    status() { return { phase: this.phase }; }
  }
  const { controller, profile } = await fixture(t, { SessionClass: Session });
  await profile.save({ ...profile.data.values, LOG_LEVEL: 'error' });
  await controller.start('manual');
  let changes = 0; controller.on('change', () => { changes++; });
  controller.logger('error').info('turn', '低级别系统日志');
  for (let i = 0; i < 105; i++) controller.session.onResponse({ id: String(i), source: 'codex', text: `回答 ${i}\n第二段`, player: 'Alice', timestamp: new Date().toISOString() });
  const snapshot = await controller.snapshot();
  assert.equal(changes, 105);
  assert.equal(snapshot.logs.length, 0);
  assert.equal(snapshot.aiResponses.length, 100);
  assert.equal(snapshot.aiResponses[0].id, '5');
  assert.equal(snapshot.aiResponses.at(-1).text, '回答 104\n第二段');
  await controller.stop();
  assert.deepEqual((await controller.snapshot()).aiResponses, snapshot.aiResponses);
});

test('同一时间只执行一个管理操作，忙碌状态不会永久卡住', async t => {
  const { controller } = await fixture(t);
  let release; const first = controller.run('pending', () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve(); await assert.rejects(controller.run('other', () => {}), /等待/);
  release(); await first; assert.equal(controller.busy, null);
  await assert.rejects(controller.run('fail', () => { throw new Error('预期失败'); }));
  assert.equal(await controller.run('next', () => 42), 42);
});

test('桌面手工请求使用配置的玩家名称并生成独立事件 ID', async t => {
  const { controller, profile } = await fixture(t);
  await assert.rejects(controller.sendMessage('观察'), /请先启动/);
  await profile.save({ ...profile.data.values, TEST_PLAYER: 'Alice' });
  const events = [];
  controller.session = { activated: true, bridge: { accept: async event => { events.push(event); } }, stop: async () => {} };
  await controller.sendMessage('我检查门'); await controller.sendMessage('我检查门');
  assert.notEqual(events[0].id, events[1].id);
  assert.ok(events.every(event => event.player === 'Alice' && event.metadata.source === 'desktop'));
  assert.ok(events.every(event => event.text === '我检查门' && event.type === 'player-message'));
});

test('桌面将审核对话交给当前跑团 Session，并允许在停止时重新打开记录', async t => {
  const { controller, config } = await fixture(t);
  const calls = [];
  await assert.rejects(controller.reviewMessage({ id: 'A', text: '请核对' }), /请先启动/);
  controller.session = { activated: true, bridge: {
    requestReview: async (id, text) => { calls.push(['review', id, text]); return '已核对'; },
    setReviewResolved: async (id, resolved) => calls.push(['resolved', id, resolved]),
  }, stop: async () => {} };
  assert.equal(await controller.reviewMessage({ id: 'A', text: '请核对' }), '已核对');
  await controller.setReviewResolved({ id: 'A', resolved: true });
  assert.deepEqual(calls, [['review', 'A', '请核对'], ['resolved', 'A', true]]);

  controller.session = null;
  const store = new ThreadStore(config.stateFile); await store.load();
  await store.enqueue({ id: 'B', text: '旧请求' }); await store.begin('B'); await store.finish('B', 'uncertain');
  await controller.setReviewResolved({ id: 'B', resolved: true });
  const snapshot = await controller.snapshot();
  assert.equal(snapshot.reviewIssues[0].resolvedAt !== null, true);
  assert.equal(snapshot.status.uncertain, 0);
});

test('桌面 GM 控制台把要求交给当前跑团 Session，并从状态快照返回历史', async t => {
  const { controller, config } = await fixture(t);
  await assert.rejects(controller.gmMessage('切换场景'), /请先启动/);
  const calls = [];
  controller.session = { activated: true, bridge: {
    requestGmMessage: async text => { calls.push(text); return '已完成'; },
  }, stop: async () => {} };
  assert.equal(await controller.gmMessage('切换场景'), '已完成');
  assert.deepEqual(calls, ['切换场景']);

  controller.session = null;
  const store = new ThreadStore(config.stateFile); await store.load();
  await store.addGmMessage('gm', '重新布置 Token');
  await store.addGmMessage('assistant', '布置完成', { turnId: 'gm-turn' });
  const snapshot = await controller.snapshot();
  assert.deepEqual(snapshot.gmMessages.map(message => message.role), ['gm', 'assistant']);
  assert.equal(snapshot.gmMessages[1].turnId, 'gm-turn');
});

test('目录查询失败也关闭客户端并释放锁，不采用待修正的模型', async t => {
  let stopped = false;
  class Client {
    constructor(config) { assert.equal(config.model, undefined); assert.equal(config.readOnlyProbe, true); }
    async start() {} async request() { throw new Error('查询失败'); } async stop() { stopped = true; }
  }
  const { controller, config } = await fixture(t, { ClientClass: Client });
  await assert.rejects(controller.fetchModels(), /查询失败/); assert.equal(stopped, true);
  await assert.rejects(access(config.lockFile), { code: 'ENOENT' });
  await assert.rejects(access(config.stateFile + '.lock'), { code: 'ENOENT' });
});

test('客户端清理失败保留锁，随后成功关闭才允许接管', async t => {
  let stops = 0;
  class Client { async start() {} async request() { return { data: [], nextCursor: null }; } async stop() { if (++stops === 1) throw new Error('清理失败'); } }
  const { controller, config } = await fixture(t, { ClientClass: Client });
  await assert.rejects(controller.fetchModels(), /清理失败/); await access(config.lockFile);
  await controller.closeClient();
  await assert.rejects(access(config.lockFile), { code: 'ENOENT' });
});

test('清除固定对话设置失败时，不取消原跑团待办', async t => {
  const { controller, profile, config } = await fixture(t), store = new ThreadStore(config.stateFile);
  await store.load(); await store.saveThread('old-thread');
  await store.enqueue({ id: 'A', type: 'player-message', player: 'A', text: '保留', timestamp: new Date().toISOString(), metadata: {} });
  const before = await readFile(config.stateFile, 'utf8');
  profile.file = profile.directory; // 用目录模拟配置写入失败。
  await assert.rejects(controller.resetSession());
  assert.equal(await readFile(config.stateFile, 'utf8'), before);
});

test('只读检查沿用已有世界配对，尚未配对时允许查询当前世界', async t => {
  const modes = [];
  class Session {
    constructor() { this.phase = 'stopped'; this.bridge = { doctor: async () => ({ id: 'world', name: '世界' }) }; }
    async start(options) { assert.equal(options.inspectionOnly, true); modes.push(options.mode); }
    async stop() { this.phase = 'stopped'; }
  }
  const { controller } = await fixture(t, { SessionClass: Session });
  await controller.doctor();
  await controller.configurePairing({ worldId: 'world', relayUserId: 'gm', origins: 'http://localhost:30000', port: 3210 });
  await controller.doctor();
  assert.deepEqual(modes, ['manual', 'foundry']);
});

test('Codex 必须同时通过版本和 Familiar 配置检查，失败清除上次成功结果', async t => {
  let result = { version: 'codex-cli 0.153.4', servers: [{ name: 'familiar', enabled: true }] };
  const { controller } = await fixture(t, { inspect: async () => result });
  await controller.checkEnvironment();
  assert.equal((await controller.snapshot()).connections.codex.state, 'passed');
  controller.connections.worldResult({ name: '旧世界' }, true);
  result = { ...result, servers: [{ name: 'familiar', enabled: false }] };
  await assert.rejects(controller.checkEnvironment(), /没有启用/);
  let snapshot = await controller.snapshot();
  assert.equal(snapshot.environment, null);
  assert.equal(snapshot.connections.codex.state, 'failed');
  assert.equal(snapshot.connections.world.state, 'untested');
  result = { ...result, version: 'codex-cli 0.0.0' };
  await assert.rejects(controller.checkEnvironment(), /需要已适配/);
  snapshot = await controller.snapshot();
  assert.equal(snapshot.connections.codex.state, 'failed');
  assert.match(snapshot.connections.codex.message, /0.0.0/);
});

test('只读结果在 Session 停止后保留，配对文件自身不能完成世界验证', async t => {
  let failure, readWorld = { id: 'world', name: '测试世界' };
  class Session {
    constructor() { this.phase = 'stopped'; this.bridge = { doctor: async () => { if (failure) throw failure; return readWorld; } }; }
    async start({ inspectionOnly }) { assert.equal(inspectionOnly, true); this.phase = 'checking'; }
    async stop() { this.phase = 'stopped'; }
    status() { return { phase: this.phase, healthy: false }; }
  }
  const { controller, profile } = await fixture(t, { SessionClass: Session });
  await controller.doctor();
  assert.equal((await controller.snapshot()).connections.world.state, 'untested');
  const pair = { worldId: 'world', relayUserId: 'gm', origins: 'http://localhost:30000', port: 3210 };
  await controller.configurePairing(pair);
  assert.equal((await controller.snapshot()).connections.world.state, 'untested');
  await controller.doctor();
  let snapshot = await controller.snapshot();
  assert.equal(snapshot.status.phase, 'stopped');
  assert.equal(snapshot.connections.codex.state, 'passed');
  assert.equal(snapshot.connections.world.state, 'passed');
  assert.ok(snapshot.connections.world.checkedAt);
  assert.equal(snapshot.connections.push.state, 'untested');
  failure = new Error('世界暂时不可用');
  await assert.rejects(controller.doctor(), /世界暂时不可用/);
  assert.equal((await controller.snapshot()).connections.world.state, 'failed');
  failure = null; readWorld = { id: 'another-world', name: '错误世界' };
  await assert.rejects(controller.doctor(), /当前配对不一致/);
  assert.equal((await controller.snapshot()).connections.world.state, 'failed');
  readWorld = { id: 'world', name: '测试世界' }; await controller.doctor();
  await controller.configurePairing({ ...pair, rotate: true });
  assert.equal((await controller.snapshot()).connections.world.state, 'untested');
  await controller.doctor();
  await controller.saveSettings({ ...profile.data.values, CODEX_COMMAND: '/test/new-codex' });
  snapshot = await controller.snapshot();
  assert.ok(Object.values(snapshot.connections).every(check => check.state === 'untested'));
});

test('检查失败或取消后不显示通过，并继续执行会话清理', async t => {
  let stopped = 0, failCleanup = true;
  class Session {
    constructor() { this.bridge = { doctor: async () => ({ id: 'world', name: '世界' }) }; }
    async start() { this.phase = 'checking'; }
    async stop() { stopped++; this.phase = 'stopped'; if (failCleanup) throw new Error('清理失败'); }
    status() { return { phase: this.phase }; }
  }
  const { controller } = await fixture(t, { SessionClass: Session });
  await assert.rejects(controller.doctor(), /清理失败/);
  assert.equal((await controller.snapshot()).connections.world.state, 'failed');
  assert.equal(stopped, 1);
  failCleanup = false;
  Session.prototype.start = async function () { this.stopRequested = true; };
  await controller.doctor();
  assert.equal(stopped, 2);
  assert.ok(Object.values((await controller.snapshot()).connections).every(check => check.state === 'untested'));
});
