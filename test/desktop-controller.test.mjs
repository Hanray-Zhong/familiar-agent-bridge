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
