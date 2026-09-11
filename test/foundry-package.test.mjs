import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, writeFile, readdir, rm, symlink, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { modulePackageInfo, packageFoundryModule } from '../src/foundry/module-package.mjs';
import { projectRoot } from '../src/runtime/config.mjs';
const execute = promisify(execFile);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-package-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  await cp(join(projectRoot, 'foundry-module'), source, { recursive: true });
  return { dir, source, target: join(dir, 'module.zip') };
}

test('ZIP 可由系统工具解压，运行文件完整，旁置私有文件不进入安装包', async t => {
  const { dir, source, target } = await fixture(t);
  await writeFile(join(source, '.env'), 'PRIVATE_SECRET=fixture-only');
  await writeFile(join(source, 'stray.mjs'), '不被运行入口引用的临时文件');
  await mkdir(join(source, 'data')); await writeFile(join(source, 'data/state.json'), '{}');
  const result = await packageFoundryModule(source, target);
  assert.equal(result.files, 11);
  const { stdout } = await execute('unzip', ['-Z1', target], { timeout: 10000 });
  const files = stdout.trim().split('\n');
  assert.equal(files.length, result.files);
  assert.ok(files.includes('familiar-agent-bridge/ui/request-feedback.mjs'));
  assert.ok(files.includes('familiar-agent-bridge/relay/request-status.mjs'));
  assert.ok(files.every(file => file.startsWith('familiar-agent-bridge/')));
  assert.ok(!files.some(file => /\.env|stray|data\/|AGENTS|\.md$/.test(file)));
  const unpacked = join(dir, 'unpacked');
  await execute('unzip', ['-q', target, '-d', unpacked], { timeout: 10000 });
  for (const file of files) assert.deepEqual(await readFile(join(unpacked, file)), await readFile(join(source, file.slice('familiar-agent-bridge/'.length))));
  const before = await readFile(target);
  await packageFoundryModule(source, target);
  assert.deepEqual(await readFile(target), before, '相同源码产生相同 ZIP');
});

test('缺少依赖时保留旧安装包，不留下临时文件', async t => {
  const { dir, source, target } = await fixture(t);
  await writeFile(target, 'original'); await unlink(join(source, 'relay/transport.mjs'));
  await assert.rejects(packageFoundryModule(source, target), { code: 'ENOENT' });
  assert.equal(await readFile(target, 'utf8'), 'original');
  assert.deepEqual((await readdir(dir)).sort(), ['module.zip', 'source']);
});

test('拒绝越界资源、符号链接和非 ZIP 输出，不覆盖用户文件', async t => {
  const { dir, source, target } = await fixture(t);
  const { manifest } = await modulePackageInfo(source);
  await writeFile(join(dir, 'outside.mjs'), '// private');
  await writeFile(join(source, 'main.mjs'), "import '../outside.mjs';");
  await assert.rejects(packageFoundryModule(source, target), /路径无效/);
  await unlink(join(source, 'main.mjs')); await symlink('../outside.mjs', join(source, 'main.mjs'));
  await assert.rejects(packageFoundryModule(source, target), /符号链接/);
  await assert.rejects(packageFoundryModule(source, join(dir, 'state.json')), /\.zip/);
  await writeFile(join(source, 'module.json'), JSON.stringify({ ...manifest, id: '../outside' }));
  await assert.rejects(packageFoundryModule(source, target), /ID 或版本/);
});

test('打包命令支持带空格路径，不依赖 Codex 登录、.env 或 Foundry 目录', async t => {
  const { dir } = await fixture(t), target = join(dir, '输出 目录/bridge.zip');
  const args = [join(projectRoot, 'scripts/package-foundry.mjs')];
  const { stdout } = await execute(process.execPath, [...args, '--output', target], { cwd: dir, env: { ...process.env, CODEX_COMMAND: 'missing-codex', STATE_FILE: '/missing/state.json' }, timeout: 10000 });
  assert.match(stdout, /将 familiar-agent-bridge 文件夹放入 Foundry 的 Data\/modules/);
  await execute('unzip', ['-t', target], { timeout: 10000 });
  await assert.rejects(execute(process.execPath, [...args, '--data-path', dir], { timeout: 10000 }), /用法/);
  assert.deepEqual((await readdir(dir)).sort(), ['source', '输出 目录']);
});
