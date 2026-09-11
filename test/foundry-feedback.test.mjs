import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestFeedback } from '../foundry-module/ui/request-feedback.mjs';
import { createStatusPublisher, REQUEST_STATUS_FLAG, STATUS_STALE_MS } from '../foundry-module/relay/request-status.mjs';
import { MODULE_ID, ROUTES } from '../foundry-module/shared/protocol.mjs';
import { RelayController } from '../foundry-module/relay/controller.mjs';
import { FakeLocks, gameFixture, message, pairing } from './helpers/foundry.mjs';

function notifications() {
  const active = new Map(), calls = [];
  let nextId = 0;
  return { active, calls,
    info(text, options) { const item = { id: ++nextId, message: text }; active.set(item.id, item); calls.push(['info', text, options]); return item; },
    warn(text, options) { calls.push(['warn', text, options]); },
    has(item) { return active.has(item.id); },
    update(item, update) { Object.assign(active.get(item.id), update); calls.push(['update', update]); },
    remove(item) { active.delete(item.id); calls.push(['remove']); },
  };
}

async function fixture() {
  const p = await pairing(), game = gameFixture(p), ui = notifications();
  let now = Date.now();
  const feedback = new RequestFeedback({ game, notifications: ui, textOf: doc => doc.content, clock: () => now });
  const doc = message(game);
  game.messages.contents.push(doc);
  const publish = createStatusPublisher({ game, clock: () => now });
  const update = async status => { await publish(`world:${doc.id}`, status); feedback.update(doc, 'gm'); };
  return { game, ui, doc, feedback, publish, update, advance: ms => { now += ms; } };
}

test('公开请求在玩家端显示发送、排队和回答提示，完成后移除，重复状态不会刷屏', async () => {
  const f = await fixture();
  f.feedback.game = { ...f.game, user: f.game.users.get('alice') };
  f.feedback.observe(f.doc, 'alice');
  assert.match([...f.ui.active.values()][0].message, /发送请求/);
  assert.deepEqual(f.ui.calls[0][2], { permanent: true, console: false });
  await f.update('queued');
  assert.match([...f.ui.active.values()][0].message, /已排队/);
  await f.update('running');
  const count = f.ui.calls.length;
  await f.update('running');
  assert.equal(f.ui.calls.length, count);
  assert.match([...f.ui.active.values()][0].message, /正在回答/);
  await f.update('processed');
  assert.equal(f.ui.active.size, 0);
  assert.equal(f.ui.calls.filter(([type]) => type === 'info').length, 1);
  assert.equal(f.ui.calls.filter(([type]) => type === 'warn').length, 0);
});

test('并发请求合并为一条提示，完成一条不会清掉另一条的等待状态', async () => {
  const f = await fixture(), second = message(f.game, 'second');
  f.game.messages.contents.push(second);
  f.feedback.observe(f.doc, 'alice');
  f.feedback.observe(second, 'alice');
  assert.equal(f.ui.active.size, 1);
  assert.match([...f.ui.active.values()][0].message, /2 条请求/);
  await f.update('processed');
  assert.equal(f.ui.active.size, 1);
  f.feedback.remove(second.id);
  assert.equal(f.ui.active.size, 0);
});

test('异常提示指导核对后重试；取消可重新发送；终态不保留正在回答提示', async () => {
  for (const [status, pattern] of [
    ['uncertain', /可能已部分执行.*核对.*重试未完成/], ['unknown', /确认未执行后再重试/],
    ['cancelled', /已取消.*重新发送 @familiar/], ['delivery-failed', /重试待发消息/],
    ['disconnected', /检查连接.*确认未执行后再重试/], ['paused', /仍在排队/],
  ]) {
    const f = await fixture();
    f.feedback.observe(f.doc, 'alice');
    await f.update(status);
    await f.update(status);
    assert.equal(f.ui.active.size, 0);
    const warns = f.ui.calls.filter(([type]) => type === 'warn');
    assert.equal(warns.length, 1);
    assert.match(warns[0][1], pattern);
  }
});

test('GM 状态 flag 沿用密语可见范围，不向无关玩家显示请求或提示', async () => {
  for (const viewer of ['alice', 'gm', 'bob']) {
    const f = await fixture();
    f.doc.whisper = ['gm'];
    f.feedback.game = { ...f.game, user: f.game.users.get(viewer) };
    f.feedback.observe(f.doc, 'alice');
    await f.update('running');
    assert.equal(f.ui.active.size, viewer === 'bob' ? 0 : 1);
    await f.update('uncertain');
    assert.equal(f.ui.calls.filter(([type]) => type === 'warn').length, viewer === 'bob' ? 0 : 1);
  }
});

test('普通聊天、掷骰、回复和未启用的推送不会出现回答提示', async () => {
  const f = await fixture();
  for (const fields of [
    { content: '普通聊天' }, { content: '@familiar' }, { rolls: [{}] }, { blind: true },
    { flags: { familiar: { isReply: true } } }, { visible: false }, { isContentVisible: false },
    { author: f.game.user }, { whisper: ['bob'] },
  ]) f.feedback.observe(message(f.game, 'ignored', fields));
  assert.equal(f.ui.calls.length, 0);
  await f.game.settings.set('familiar', 'tableChatEnabled', true);
  f.feedback.observe(f.doc, 'alice');
  assert.equal(f.ui.calls.length, 0);
  await f.game.settings.set('familiar', 'tableChatEnabled', false);
  await f.game.settings.set(MODULE_ID, 'enabled', false);
  f.feedback.observe(f.doc, 'alice');
  assert.equal(f.ui.calls.length, 0);
});

test('拒绝过长请求时向玩家提示修改后重试', async () => {
  const f = await fixture();
  f.doc.content = `@familiar ${'长'.repeat(16001)}`;
  f.feedback.observe(f.doc, 'alice');
  assert.equal(f.ui.active.size, 0);
  assert.match(f.ui.calls[0][1], /未转发.*消息长度.*修正后重试/);
});

test('只接收指定 GM 的状态更新，忽略伪造作者、未知状态和过时更新', async () => {
  const f = await fixture();
  f.feedback.observe(f.doc, 'alice');
  await f.publish('world:msg1', 'processed');
  f.feedback.update(f.doc, 'alice');
  assert.equal(f.ui.active.size, 1);
  f.doc.flags[MODULE_ID][REQUEST_STATUS_FLAG].status = '<img src=x onerror=alert(1)>';
  f.feedback.update(f.doc, 'gm');
  assert.equal(f.ui.active.size, 1);
  f.advance(1000);
  await f.update('running');
  f.doc.flags[MODULE_ID][REQUEST_STATUS_FLAG] = { status: 'processed', updatedAt: 1, relayUserId: 'gm' };
  f.feedback.update(f.doc, 'gm');
  assert.equal(f.ui.active.size, 1);
});

test('失去 GM 状态更新后停止等待并提示核对，后续真实回执可以恢复', async () => {
  const f = await fixture();
  await f.update('running');
  f.advance(STATUS_STALE_MS);
  f.feedback.checkTimeouts();
  f.feedback.checkTimeouts();
  assert.equal(f.ui.active.size, 0);
  assert.equal(f.ui.calls.filter(([type]) => type === 'warn').length, 1);
  assert.match(f.ui.calls.find(([type]) => type === 'warn')[1], /确认未执行后再重试/);
  await f.update('running');
  assert.equal(f.ui.active.size, 1);
  await f.update('processed');
  assert.equal(f.ui.active.size, 0);
});

test('玩家电脑时钟与 GM 不同，仍接收回答及完成回执，不误判刚收到的更新为失联', async () => {
  for (const offset of [-120000, 120000]) {
    const f = await fixture();
    f.feedback.clock = () => Date.now() + offset;
    f.feedback.observe(f.doc, 'alice');
    await f.update('running');
    assert.match([...f.ui.active.values()][0].message, /正在回答/);
    f.feedback.checkTimeouts();
    assert.equal(f.ui.active.size, 1);
    await f.update('processed');
    assert.equal(f.ui.active.size, 0);
    assert.equal(f.ui.calls.filter(([type]) => type === 'warn').length, 0);
  }
});

test('刷新页面恢复 GM 写入的活跃状态，旧终态不重复弹出；停止时释放提示和定时器', async t => {
  const f = await fixture();
  await f.publish('world:msg1', 'running');
  assert.equal(f.doc._stats.lastModifiedBy, 'gm');
  const old = message(f.game, 'old');
  f.game.messages.contents.push(old);
  await f.publish('world:old', 'uncertain');
  f.feedback.start();
  t.after(() => f.feedback.stop());
  assert.equal(f.ui.active.size, 1);
  assert.equal(f.ui.calls.filter(([type]) => type === 'warn').length, 0);
  f.feedback.stop();
  assert.equal(f.ui.active.size, 0);
});

test('相同活跃状态定期刷新，终态不重复写；不会修改消息正文或密语接收者', async () => {
  const f = await fixture();
  f.doc.whisper = ['gm'];
  const content = f.doc.content, createdTime = f.doc._stats.createdTime;
  const writes = [];
  const setFlag = f.doc.setFlag;
  f.doc.setFlag = async (...args) => { writes.push(args); await setFlag.apply(f.doc, args); };
  await f.publish('world:msg1', 'running');
  f.advance(10000);
  await f.publish('world:msg1', 'running');
  assert.equal(writes.length, 1);
  f.advance(20000);
  await f.publish('world:msg1', 'running');
  assert.equal(writes.length, 2);
  await f.publish('world:msg1', 'processed');
  f.advance(60000);
  await f.publish('world:msg1', 'processed');
  await f.publish('other:msg1', 'running');
  await f.publish('world:deleted', 'running');
  assert.equal(writes.length, 3);
  assert.equal(f.doc.content, content);
  assert.equal(f.doc._stats.createdTime, createdTime);
  assert.deepEqual(f.doc.whisper, ['gm']);
});

test('同步提示失败会向调用方报告，恢复后可以重试', async () => {
  const f = await fixture(), setFlag = f.doc.setFlag;
  f.doc.setFlag = async () => { throw new Error('socket offline'); };
  await assert.rejects(f.publish('world:msg1', 'running'), /socket offline/);
  f.doc.setFlag = setFlag;
  await f.publish('world:msg1', 'running');
  assert.equal(f.doc.flags[MODULE_ID][REQUEST_STATUS_FLAG].status, 'running');
});

test('Foundry 状态同步卡住时有独立超时，不会永久阻塞待发队列', async t => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.doc.setFlag = () => new Promise(() => {});
  const publishing = f.publish('world:msg1', 'running');
  const rejected = assert.rejects(publishing, /同步超时/);
  t.mock.timers.tick(5000);
  await rejected;
});

test('刷新不信任玩家最后修改的状态 flag，停用推送会清理活跃提示', async t => {
  const f = await fixture();
  await f.publish('world:msg1', 'running');
  f.doc._stats.lastModifiedBy = 'alice';
  f.feedback.start();
  t.after(() => f.feedback.stop());
  assert.equal(f.ui.active.size, 0);
  f.feedback.update(f.doc, 'gm');
  assert.equal(f.ui.active.size, 1);
  await f.game.settings.set(MODULE_ID, 'enabled', false);
  f.feedback.checkTimeouts();
  assert.equal(f.ui.active.size, 0);
});

test('GM 中继消费请求并同步 flag，玩家提示随实际 Outbox 回执完成', async t => {
  const f = await fixture();
  f.feedback.game = { ...f.game, user: f.game.users.get('alice') };
  f.feedback.observe(f.doc, 'alice');
  const synced = Promise.withResolvers();
  const setFlag = f.doc.setFlag;
  f.doc.setFlag = async (...args) => {
    await setFlag.apply(f.doc, args);
    f.feedback.update(f.doc, 'gm');
    if (args[2].status === 'processed') synced.resolve();
  };
  let eventPosts = 0;
  const locks = new FakeLocks();
  const controller = new RelayController({ game: f.game, locks, textOf: doc => doc.content, notify: () => {},
    post: async (_pair, path, body) => {
      if (path === ROUTES.events) { eventPosts++; return { id: body.event.id, status: 'queued' }; }
      return { receipts: body.ids.map(id => ({ id, status: 'processed' })) };
    } });
  t.after(async () => { await controller.stop(); f.feedback.stop(); });
  const lease = controller.tick();
  await synced.promise;
  assert.equal(eventPosts, 1);
  assert.equal(f.ui.active.size, 0);
  assert.equal(f.doc.flags[MODULE_ID][REQUEST_STATUS_FLAG].status, 'processed');
  await controller.stop(); await lease;
  assert.equal(locks.held.size, 0);
});
