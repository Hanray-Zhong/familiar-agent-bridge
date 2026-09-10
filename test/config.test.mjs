import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/runtime/config.mjs';

async function fixture(t, text = '') {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-config-test-'));
  await writeFile(join(dir, '.env'), text);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { root: dir };
}

test('桌面配置只使用传入值，不自动读取 .env 或进程中的模型设置', async t => {
  const options = await fixture(t, 'CODEX_MODEL=from-file\nCODEX_REASONING_EFFORT=high\n');
  const previous = process.env.CODEX_MODEL;
  process.env.CODEX_MODEL = 'from-process';
  t.after(() => { if (previous === undefined) delete process.env.CODEX_MODEL; else process.env.CODEX_MODEL = previous; });
  const config = await loadConfig({ CODEX_MODEL: 'from-settings', CODEX_REASONING_EFFORT: '', CODEX_THREAD_ID: '' }, options);
  assert.equal(config.model, 'from-settings');
  assert.equal(config.reasoningEffort, undefined);
  assert.equal(config.threadId, undefined);
  const defaults = await loadConfig({}, options);
  assert.equal(defaults.model, undefined);
  assert.equal(defaults.reasoningEffort, undefined);
  assert.equal(defaults.threadId, undefined);
});

test('配置错误在启动前指出具体设置；effort 的模型支持范围交给实时目录', async t => {
  const options = await fixture(t);
  for (const [key, value] of [['CODEX_THREAD_ID', '跑团标题'], ['CODEX_MODEL', 'model --unsafe'], ['CODEX_REASONING_EFFORT', 'HIGH'], ['CODEX_TURN_TIMEOUT_MS', '5m']]) {
    await assert.rejects(loadConfig({ [key]: value }, options), new RegExp(key));
  }
  const config = await loadConfig({ CODEX_REASONING_EFFORT: 'future-effort', CODEX_MAX_RESTARTS: '0' }, options);
  assert.equal(config.reasoningEffort, 'future-effort');
  assert.equal(config.maxRestarts, 0);
});
