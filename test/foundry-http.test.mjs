import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ThreadStore } from '../src/thread-store.mjs';
import { FoundryEventSource } from '../src/event-source/foundry.mjs';
import { RequestAuth } from '../src/foundry/auth.mjs';
import { loadPairing } from '../src/foundry/pairing.mjs';
import { signedPost } from '../foundry-module/relay/transport.mjs';
import { ROUTES, signingText } from '../foundry-module/shared/protocol.mjs';
import { buildFoundryEvent } from '../foundry-module/relay/message.mjs';
import { pairing, gameFixture, message } from './helpers/foundry.mjs';

async function setup(t, accept) {
  const pair = await pairing();
  const dir = await mkdtemp(join(tmpdir(), 'familiar-http-test-'));
  const store = new ThreadStore(join(dir, 'state.json'), { historyLimit: 1 });
  await store.load();
  const source = new FoundryEventSource({ pairing: pair,
    accept: accept ?? (async event => ({ accepted: await store.enqueue(event), id: event.id })),
    status: () => ({ healthy: true, paused: false, queued: store.snapshot().queued.length }), receipts: ids => store.foundryStatuses(ids) });
  await source.start();
  t.after(async () => { await source.stop(); await rm(dir, { recursive: true, force: true }); });
  const game = gameFixture(pair);
  const event = buildFoundryEvent(message(game), game, pair, { text: '@familiar 我检查门' });
  return { pair, source, store, event, dir };
}

function request(pair, path, payload, overrides = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify({ protocol: 1, worldId: pair.worldId, relayUserId: pair.relayUserId, ...payload });
  const timestamp = String(Date.now()), nonce = randomUUID();
  const headers = { 'Content-Type': 'application/json', Origin: pair.allowedOrigins[0], 'X-Bridge-Timestamp': timestamp,
    'X-Bridge-Nonce': nonce, 'X-Bridge-Signature': createHmac('sha256', pair.secret).update(signingText(path, timestamp, nonce, body)).digest('hex'), ...overrides };
  return { method: 'POST', headers, body };
}

test('真实 HTTP + 浏览器 WebCrypto 双向签名，ACK 落盘、状态查询和重复消息', async t => {
  const { pair, store, event } = await setup(t);
  const result = await signedPost(pair, ROUTES.events, { event });
  assert.equal(result.accepted, true);
  assert.equal(result.status, 'queued');
  assert.equal(store.snapshot().queued.length, 1);
  assert.equal((await signedPost(pair, ROUTES.events, { event })).accepted, false);
  await store.begin(event.id);
  await store.finish(event.id, 'processed');
  const status = await signedPost(pair, ROUTES.status, { ids: [event.id] });
  assert.equal(status.receipts[0].status, 'processed');
});

test('跨重启、超过普通回执窗口也不重放 Foundry ID，改内容返回冲突', async t => {
  const { pair, source, store, event, dir } = await setup(t);
  await signedPost(pair, ROUTES.events, { event });
  await store.begin(event.id); await store.finish(event.id, 'processed');
  await store.enqueue({ id: 'another', text: 'x' }); await store.begin('another'); await store.finish('another', 'processed');
  assert.equal(store.snapshot().receipts.some(receipt => receipt.id === event.id), false);
  await source.stop();
  const reloaded = new ThreadStore(join(dir, 'state.json')); await reloaded.load();
  const next = new FoundryEventSource({ pairing: pair,
    accept: async value => ({ id: value.id, accepted: await reloaded.enqueue(value) }),
    status: () => ({ healthy: true, paused: false, queued: 0 }), receipts: ids => reloaded.foundryStatuses(ids) });
  await next.start(); t.after(() => next.stop());
  const duplicate = await signedPost(pair, ROUTES.events, { event });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.status, 'processed');
  const changed = await fetch(pair.bridgeUrl + ROUTES.events, request(pair, ROUTES.events, { event: { ...event, text: '改写内容' } }));
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error, 'EVENT_CONFLICT');
});

test('拒绝坏签名、过期签名与 nonce 重放', async t => {
  const { pair, store, event } = await setup(t);
  for (const headers of [{ 'X-Bridge-Signature': '0'.repeat(64) }, { 'X-Bridge-Timestamp': '1000000000000' }]) {
    const response = await fetch(pair.bridgeUrl + ROUTES.events, request(pair, ROUTES.events, { event }, headers));
    assert.equal(response.status, 401); await response.text();
  }
  assert.equal(store.snapshot().queued.length, 0);
  const signed = request(pair, ROUTES.events, { event });
  const first = await fetch(pair.bridgeUrl + ROUTES.events, signed); await first.text();
  const replay = await fetch(pair.bridgeUrl + ROUTES.events, signed);
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, 'REPLAY');
  assert.equal(store.snapshot().queued.length, 1);
});

test('精确 CORS/Host、请求体大小、协议与身份过滤', async t => {
  const { pair, store, event } = await setup(t);
  const badOrigin = await fetch(pair.bridgeUrl + ROUTES.events, request(pair, ROUTES.events, { event }, { Origin: 'https://attacker.example' }));
  assert.equal(badOrigin.status, 403); await badOrigin.text();
  const preflight = await fetch(pair.bridgeUrl + ROUTES.events, { method: 'OPTIONS', headers: {
    Origin: pair.allowedOrigins[0], 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-bridge-signature' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), pair.allowedOrigins[0]);
  for (const payload of [{ event, worldId: 'elsewhere' }, { event, relayUserId: 'alice' }, { event, protocol: 2 }]) {
    const response = await fetch(pair.bridgeUrl + ROUTES.events, request(pair, ROUTES.events, payload));
    assert.ok([400, 403].includes(response.status)); await response.text();
  }
  const wrongId = { ...event, id: 'world:other' };
  const rejected = await fetch(pair.bridgeUrl + ROUTES.events, request(pair, ROUTES.events, { event: wrongId }));
  assert.equal(rejected.status, 400); await rejected.text();
  const oversized = await fetch(pair.bridgeUrl + ROUTES.events, request(pair, ROUTES.events, 'x'.repeat(70000)));
  assert.equal(oversized.status, 413); await oversized.text();
  assert.equal(store.snapshot().queued.length, 0);
});

test('持久化失败不能返回 ACK，客户端拒绝伪造成功响应', async t => {
  const { pair, event } = await setup(t, async () => { throw Object.assign(new Error('disk failure'), { code: 'STORE_FAILURE' }); });
  await assert.rejects(signedPost(pair, ROUTES.events, { event }), /503/);
  const fake = async () => new Response(JSON.stringify({ protocol: 1, id: event.id, accepted: true, status: 'queued' }), { status: 202 });
  await assert.rejects(signedPost(pair, ROUTES.events, { event }, { fetchImpl: fake }), /缺少签名/);
});

test('请求限流有明确上限并按时间恢复', () => {
  let time = 1000000000000;
  const auth = new RequestAuth('test', { clock: () => time });
  for (let i = 0; i < 60; i++) auth.rateLimit();
  assert.throws(() => auth.rateLimit(), { code: 'RATE_LIMIT' });
  time += 500;
  assert.doesNotThrow(() => auth.rateLimit());
});

test('损坏的私有配对文件不回显密钥内容', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-private-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'pairing.json');
  await writeFile(file, 'private-value-that-must-not-be-echoed', { mode: 0o600 });
  await assert.rejects(loadPairing(file), error => error.message.includes('私有配对 JSON') && !error.message.includes('private-value'));
});
