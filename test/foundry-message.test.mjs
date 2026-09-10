import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRequest, buildFoundryEvent, canRelay } from '../foundry-module/relay/message.mjs';
import { validatePairing, MODULE_ID } from '../foundry-module/shared/protocol.mjs';
import { pairing, gameFixture, message } from './helpers/foundry.mjs';

test('@familiar 只匹配开头的完整提及，支持中文标点', () => {
  assert.equal(extractRequest('@FAMILIAR： 我检查门'), '我检查门');
  for (const text of ['引用：@familiar 你好', '@familiarly 你好', '@familiar', 'someone@familiar.com']) assert.equal(extractRequest(text), null);
});

test('author 决定身份，不信任别名；角色必须由该玩家拥有', async () => {
  const p = await pairing(), game = gameFixture(p);
  const doc = message(game, 'msg1', { speaker: { alias: '主持人' }, speakerActor: { id: 'pc', testUserPermission: () => false } });
  const event = buildFoundryEvent(doc, game, p, { text: doc.content, creatorId: 'alice' });
  assert.equal(event.player, 'Alice');
  assert.equal(event.id, 'world:msg1');
  assert.equal(event.metadata.actorId, null);
  assert.equal(event.metadata.playerId, 'alice');
  assert.equal(buildFoundryEvent(doc, game, p, { text: doc.content, creatorId: 'bob' }), null);
});

test('过滤 Familiar / Codex 回复、盲掷、非接收者密语、骰子和 GM 默认输入', async () => {
  const p = await pairing(), game = gameFixture(p);
  for (const override of [
    { flags: { familiar: { anyReplyFlag: true } } }, { flags: { [MODULE_ID]: { isAgentReply: true } } },
    { blind: true }, { rolls: [{}] }, { isContentVisible: false }, { author: game.user }, { speaker: { alias: 'Familiar' } }, { whisper: ['bob'] },
  ]) assert.equal(buildFoundryEvent(message(game, 'msg1', override), game, p, { text: '@familiar 检查门' }), null);
});

test('密语保留原接收者并加入提问玩家，重复名称时拒绝路由', async () => {
  const p = await pairing(), game = gameFixture(p);
  const doc = message(game, 'private', { whisper: ['gm', 'bob'] });
  const event = buildFoundryEvent(doc, game, p, { text: doc.content });
  assert.deepEqual(event.metadata.whisperUserIds, ['gm', 'bob', 'alice']);
  assert.deepEqual(event.metadata.whisperTo, ['主持人', 'Bob', 'Alice']);
  game.users.contents.push({ id: 'other', name: 'Alice', isGM: false });
  assert.throws(() => buildFoundryEvent(doc, game, p, { text: doc.content }), /同名/);
});

test('仅指定 GM 可推送，Familiar 自动回答开启时暂停', async () => {
  const p = await pairing(), game = gameFixture(p);
  assert.equal(canRelay(game, p), true);
  game.user = game.users.get('alice');
  assert.equal(canRelay(game, p), false);
  game.user = game.users.get('gm');
  await game.settings.set('familiar', 'tableChatEnabled', true);
  assert.equal(canRelay(game, p), false);
});

test('配对只允许本机地址、足够熵的 key 和精确 Origin', async () => {
  const p = await pairing();
  assert.equal(validatePairing(p).worldId, 'world');
  for (const bad of [{ bridgeUrl: 'http://0.0.0.0:3210' }, { secret: 'short' }, { allowedOrigins: ['*'] }, { relayUserId: '../a' }]) {
    assert.throws(() => validatePairing({ ...p, ...bad }));
  }
});

test('作者提供的显示时间不会改变采集时间或游标依据', async () => {
  const p = await pairing(), game = gameFixture(p);
  const doc = message(game, 'timestamp', { timestamp: Date.now() + 365 * 86400000 });
  const event = buildFoundryEvent(doc, game, p, { text: doc.content });
  assert.equal(Date.parse(event.timestamp), doc._stats.createdTime);
  assert.equal(buildFoundryEvent({ ...doc, _stats: {} }, game, p, { text: doc.content }), null);
});
