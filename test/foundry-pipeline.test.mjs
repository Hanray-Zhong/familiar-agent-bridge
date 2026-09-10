import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../src/runtime/bridge.mjs';
import { FoundryEventSource } from '../src/event-source/foundry.mjs';
import { buildFoundryEvent } from '../foundry-module/relay/message.mjs';
import { signedPost } from '../foundry-module/relay/transport.mjs';
import { ROUTES } from '../foundry-module/shared/protocol.mjs';
import { pairing, gameFixture, message } from './helpers/foundry.mjs';

test('Foundry 文档 → 签名 Push → Bridge → 同一 Thread 串行 Turn → 持久化完成回执', async t => {
  const pair = await pairing(), game = gameFixture(pair);
  const dir = await mkdtemp(join(tmpdir(), 'familiar-pipeline-test-'));
  await writeFile(join(dir, 'AGENTS.md'), '测试长期指令');
  const codex = new EventEmitter();
  codex.familiarServer = 'familiar';
  codex.start = async () => { codex.child = {}; codex.connection = { closed: false }; };
  codex.stop = async () => { codex.child = null; codex.connection = { closed: true }; };
  codex.interruptActive = async () => {};
  let starts = 0, active = 0, maximum = 0;
  const prompts = [], trace = [];
  codex.startThread = async () => { starts++; return { thread: { id: 'one-thread' }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never' }; };
  codex.runTurn = async (threadId, prompt, { eventId }) => {
    assert.equal(threadId, 'one-thread');
    active++; maximum = Math.max(maximum, active); trace.push(`start:${eventId}`); prompts.push(prompt);
    await delay(15);
    trace.push(`end:${eventId}`); active--;
    return { turn: { id: `turn-${eventId}` }, items: ['get-world-info', 'send-chat-message'].map(tool => ({ type: 'mcpToolCall', tool, server: 'familiar', status: 'completed' })) };
  };
  const logger = Object.fromEntries(['info', 'warn', 'debug', 'error'].map(level => [level, () => {}]));
  const bridge = new Bridge({ cwd: dir, stateFile: join(dir, 'state.json'), lockFile: join(dir, 'bridge.lock'),
    instructionsFile: join(dir, 'AGENTS.md'), queueLimit: 20, familiarServer: 'familiar', expectedWorldId: 'world',
    maxRestarts: 1, healthIntervalMs: 10000, healthTimeoutMs: 1000, turnTimeoutMs: 1000, shutdownTimeoutMs: 1000 }, logger,
  { codex, health: async () => ({ world: { id: 'world', name: '测试世界' } }) });
  let source;
  t.after(async () => { await source?.stop(); await bridge.stop(); await rm(dir, { recursive: true, force: true }); });
  await bridge.start();
  source = new FoundryEventSource({ pairing: pair, accept: event => bridge.accept(event), status: () => bridge.status(), receipts: ids => bridge.store.foundryStatuses(ids) });
  await source.start();
  const events = ['A', 'B', 'C'].map(id => buildFoundryEvent(message(game, id, id === 'B' ? { whisper: ['gm'] } : {}), game, pair, { text: `@familiar ${id}` }));
  for (const event of events) await signedPost(pair, ROUTES.events, { event });
  await bridge.drain();
  assert.equal(starts, 1); assert.equal(maximum, 1);
  assert.deepEqual(trace, ['start:world:A', 'end:world:A', 'start:world:B', 'end:world:B', 'start:world:C', 'end:world:C']);
  const status = await signedPost(pair, ROUTES.status, { ids: events.map(event => event.id) });
  assert.ok(status.receipts.every(receipt => receipt.status === 'processed'));
  assert.ok(prompts[1].includes('"whisperTo":["主持人","Alice"]'));
  assert.ok(prompts[1].includes('"playerId":"alice"'));
  assert.equal((await signedPost(pair, ROUTES.events, { event: events[0] })).accepted, false);
  assert.equal(trace.length, 6);
});
