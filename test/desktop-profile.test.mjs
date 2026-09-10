import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, unlink, stat, realpath, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProfileStore } from '../desktop/main/profile-store.mjs';
import { DesktopController } from '../desktop/main/controller.mjs';
import { projectRoot, loadConfig } from '../src/runtime/config.mjs';
import { configDefaults } from '../src/runtime/config-fields.mjs';
import { serverArgs, threadOptions } from '../src/codex/policy.mjs';
import { acquireLock } from '../src/storage/instance-lock.mjs';
import { prepareDevelopmentData, reuseLegacyData } from '../desktop/main/application-paths.mjs';

async function profile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-desktop-profile-'));
  const store = new ProfileStore(dir, projectRoot); await store.load();
  t.after(() => rm(dir, { recursive: true, force: true })); return store;
}

test('开发首次启动先创建数据目录；打包版不接受开发数据覆盖', async t => {
  const store = await profile(t), directory = join(store.directory, 'new-app-data');
  let called = false;
  prepareDevelopmentData({ isPackaged: false, setPath(name, path) { assert.equal(name, 'userData'); assert.equal(path, directory); assert.ok(existsSync(path)); called = true; } }, projectRoot, { FAMILIAR_BRIDGE_APP_DATA: directory });
  assert.equal(called, true);
  prepareDevelopmentData({ isPackaged: true, setPath() { throw new Error('不应修改'); } }, projectRoot, { FAMILIAR_BRIDGE_APP_DATA: directory });
});

test('应用重命名后复用旧数据；空目录不阻止恢复，已有新配置时不覆盖', async t => {
  const store = await profile(t), previous = join(store.directory, 'Familiar Codex Bridge');
  const current = join(store.directory, 'Familiar Agent Bridge');
  const paths = [], app = { isPackaged: true, getPath: () => store.directory, setPath: (key, value) => paths.push([key, value]) };
  reuseLegacyData(app); assert.deepEqual(paths, []);
  await mkdir(previous); await writeFile(join(previous, 'settings.json'), '原有数据');
  reuseLegacyData(app); assert.deepEqual(paths, [['userData', previous]]);
  paths.length = 0;
  await mkdir(current);
  reuseLegacyData(app); assert.deepEqual(paths, [['userData', previous]]);
  paths.length = 0;
  await writeFile(join(current, 'settings.json'), '新的配置');
  reuseLegacyData(app); assert.deepEqual(paths, []);
  reuseLegacyData({ isPackaged: false, getPath() { throw new Error('开发版不检查系统目录'); } });
  assert.equal(await readFile(join(previous, 'settings.json'), 'utf8'), '原有数据');
  assert.equal(await readFile(join(current, 'settings.json'), 'utf8'), '新的配置');
});

test('跑团规则的符号链接也不能指向开发规则', async t => {
  const store = await profile(t), root = store.data.root;
  await writeFile(join(root, 'AGENTS.md'), '开发规则'); await symlink('AGENTS.md', join(root, 'alias.md'));
  await assert.rejects(loadConfig({ DM_INSTRUCTIONS_FILE: './alias.md' }, { root }), /开发用/);
});

test('开发与 DM 规则隔离，默认文件正确且关闭隐式项目规则', async () => {
  const config = await loadConfig();
  assert.equal(config.instructionsFile, join(projectRoot, 'agents/dm/AGENTS.md'));
  assert.match(await readFile(join(projectRoot, 'AGENTS.md'), 'utf8'), /^# familiar-agent-bridge 开发指南/);
  assert.match(await readFile(config.instructionsFile, 'utf8'), /^# Familiar AI DM/);
  await assert.rejects(loadConfig({ DM_INSTRUCTIONS_FILE: './AGENTS.md' }), /开发用/);
  assert.ok(serverArgs([{ name: 'familiar', enabled: true }], 'familiar').includes('project_doc_max_bytes=0'));
  assert.equal(threadOptions('/tmp', 'DM rules').config.project_doc_max_bytes, 0);
});

test('桌面数据与安装资源分开，用户规则保存后可恢复且不改模板', async t => {
  const store = await profile(t), config = await store.config();
  const template = await readFile(join(projectRoot, 'agents/dm/AGENTS.md'), 'utf8');
  assert.ok(config.instructionsFile.startsWith(store.directory));
  await store.saveRules(template + '\n- 测试独立规则。\n');
  const reloaded = new ProfileStore(store.directory, projectRoot); await reloaded.load();
  assert.match(await reloaded.rules(), /测试独立规则/);
  assert.equal(await readFile(join(projectRoot, 'agents/dm/AGENTS.md'), 'utf8'), template);
  assert.equal((await stat(config.instructionsFile)).mode & 0o777, 0o600);
  await assert.rejects(store.saveRules(''), /不能为空/);
  await assert.rejects(store.saveRules('中'.repeat(30000)), /64 KB/);
  assert.match(await store.rules(), /测试独立规则/);
});

test('配置校验失败不覆盖原设置；损坏文件也不自动重置', async t => {
  const store = await profile(t), before = await readFile(store.file, 'utf8');
  await assert.rejects(store.save({ ...configDefaults, CODEX_TURN_TIMEOUT_MS: '0' }), /CODEX_TURN_TIMEOUT_MS/);
  await assert.rejects(store.save({ ...configDefaults, DANGEROUS: 'x' }), /不支持/);
  assert.equal(await readFile(store.file, 'utf8'), before);
  await writeFile(store.file, '{broken');
  await assert.rejects(new ProfileStore(store.directory, projectRoot).load(), /无法读取/);
  assert.equal(await readFile(store.file, 'utf8'), '{broken');
});

test('初始化中断后保留已经写好的用户规则，不覆盖恢复', async t => {
  const store = await profile(t); await store.saveRules('用户自己保存的规则');
  await unlink(store.file);
  const next = new ProfileStore(store.directory, projectRoot); await next.load();
  assert.equal((await next.rules()).trim(), '用户自己保存的规则');
});

test('接管旧版数据复用状态及锁路径，迁移测试玩家名称且不复制密钥', async t => {
  const store = await profile(t), cli = join(store.directory, 'cli');
  await mkdir(join(cli, 'agents/dm'), { recursive: true }); await mkdir(join(cli, 'data'));
  await writeFile(join(cli, 'package.json'), JSON.stringify({ name: 'familiar-codex-bridge' }));
  await writeFile(join(cli, 'agents/dm/AGENTS.md'), 'CLI 规则');
  const originalEnv = 'CODEX_MODEL=test-model\nSTDIN_PLAYER=旧版玩家\nPRIVATE_SECRET=fixture-only\n';
  await writeFile(join(cli, '.env'), originalEnv);
  const state = '{"threadId":"old-thread","queued":[{"id":"old-message"}]}';
  await writeFile(join(cli, 'data/state.json'), state);
  await store.importProject(cli);
  const config = await store.config();
  const canonical = await realpath(cli);
  assert.equal(config.stateFile, join(canonical, 'data/state.json'));
  assert.equal(config.lockFile, join(canonical, 'data/bridge.lock'));
  assert.equal(config.model, 'test-model');
  assert.equal(config.player, '旧版玩家');
  assert.equal(store.data.values.TEST_PLAYER, '旧版玩家');
  assert.ok(!Object.hasOwn(store.data.values, 'STDIN_PLAYER'));
  assert.ok(!JSON.stringify(store.snapshot()).includes('fixture-only'));
  assert.equal(await readFile(config.stateFile, 'utf8'), state);
  assert.equal(await readFile(join(cli, '.env'), 'utf8'), originalEnv);
  await writeFile(join(cli, 'package.json'), JSON.stringify({ name: 'familiar-agent-bridge' }));
  await store.importProject(cli);
  assert.equal((await store.config()).stateFile, config.stateFile);
  assert.equal(await readFile(config.stateFile, 'utf8'), state);
});

test('已有桌面配置自动识别旧测试玩家字段，直到保存才更新磁盘', async t => {
  const store = await profile(t), values = { ...store.data.values, STDIN_PLAYER: 'Alice' };
  delete values.TEST_PLAYER;
  await writeFile(store.file, JSON.stringify({ ...store.data, values }));
  const before = await readFile(store.file);
  await store.load();
  assert.equal((await store.config()).player, 'Alice');
  assert.deepEqual(await readFile(store.file), before);
  await store.save(store.data.values);
  const saved = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(saved.values.TEST_PLAYER, 'Alice');
  assert.ok(!Object.hasOwn(saved.values, 'STDIN_PLAYER'));
});

test('桌面快照不暴露配对 secret；共享实例锁保护规则文件', async t => {
  const store = await profile(t), controller = new DesktopController(store);
  await controller.configurePairing({ worldId: 'world', relayUserId: 'gm', origins: 'http://localhost:30000', port: 3210 });
  const config = await store.config(), pair = JSON.parse(await readFile(config.foundryPairingFile, 'utf8'));
  const snapshot = await controller.snapshot();
  assert.equal(snapshot.pairing.worldId, 'world');
  assert.ok(!JSON.stringify(snapshot).includes(pair.secret));
  assert.ok(!Object.hasOwn(snapshot.pairing, 'secret'));
  const before = await store.rules(), release = await acquireLock(config.lockFile);
  try { await assert.rejects(controller.saveRules('不应覆盖'), /锁/); } finally { await release(); }
  assert.equal(await store.rules(), before);
});

test('桌面导出安装包不修改原配置，旧安装路径不再进入新配置', async t => {
  const store = await profile(t), controller = new DesktopController(store);
  await writeFile(store.file, JSON.stringify({ ...store.data, foundryDataPath: '/old/foundry' }));
  await store.load();
  const before = await readFile(store.file), info = await controller.moduleInfo();
  const target = join(store.directory, info.fileName);
  await controller.exportModule(target);
  assert.equal((await readFile(target)).readUInt32LE(0), 0x04034b50);
  assert.equal((await controller.snapshot()).modulePackage.path, target);
  assert.deepEqual(await readFile(store.file), before);
  await store.save(store.data.values);
  assert.ok(!Object.hasOwn(JSON.parse(await readFile(store.file, 'utf8')), 'foundryDataPath'));
});
