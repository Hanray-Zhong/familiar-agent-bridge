import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { projectRoot } from '../src/runtime/config.mjs';
import { checkMarkdownLinks, findMarkdownFiles } from './lib/documentation.mjs';
const { listPackage, extractFile, statFile } = createRequire(import.meta.url)('@electron/asar');
const app = join(projectRoot, 'dist/mac-arm64/Familiar Agent Bridge.app');
const archive = join(app, 'Contents/Resources/app.asar');
const entries = listPackage(archive);
const files = entries.filter(path => !statFile(archive, path.slice(1)).files);
for (const path of files) {
  assert.ok(!/(?:^|\/)(?:data|test|docs|\.git|\.idea|node_modules)(?:\/|$)/.test(path), `禁止打包：${path}`);
  assert.ok(!/\/\.env(?:\.|$)|\/state\.json$|\/foundry-push\.json$|^\/AGENTS\.md$|^\/desktop\/dev\//.test(path), `发现私有或开发文件：${path}`);
  if (/\.(?:mjs|cjs|html|css)$/.test(path)) {
    const packed = extractFile(archive, path.slice(1));
    assert.deepEqual(packed, await readFile(join(projectRoot, path.slice(1))), `安装包内容过期：${path}`);
    if (/\.(?:mjs|cjs)$/.test(path)) for (const match of packed.toString().matchAll(/(?:from\s*|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = posix.resolve(posix.dirname(path), match[1]);
      assert.ok(entries.includes(target), `缺少依赖：${path} -> ${target}`);
    }
  }
}
const pkg = JSON.parse(extractFile(archive, 'package.json'));
const sourcePackage = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
assert.equal(pkg.version, sourcePackage.version); assert.ok(entries.includes('/' + pkg.main));
const resources = join(app, 'Contents/Resources/bridge-resources');
async function compare(directory, source) {
  const packed = (await readdir(directory)).filter(name => name !== '.DS_Store').sort();
  const expected = (await readdir(source)).filter(name => name !== '.DS_Store').sort();
  assert.deepEqual(packed, expected, `资源文件列表与源码不一致：${directory}`);
  for (const entry of (await readdir(directory, { withFileTypes: true })).filter(entry => entry.name !== '.DS_Store')) {
    if (entry.isDirectory()) await compare(join(directory, entry.name), join(source, entry.name));
    else assert.deepEqual(await readFile(join(directory, entry.name)), await readFile(join(source, entry.name)), `资源过期：${entry.name}`);
  }
}
assert.deepEqual((await readdir(resources)).filter(name => name !== '.DS_Store').sort(), ['agents', 'docs', 'foundry-module']);
assert.deepEqual((await readdir(join(resources, 'docs'))).filter(name => name !== '.DS_Store'), ['user-manual'], '安装包只应包含用户文档');
for (const directory of ['agents/dm', 'foundry-module', 'docs/user-manual']) await compare(join(resources, directory), join(projectRoot, directory));
await checkMarkdownLinks(await findMarkdownFiles(join(resources, 'docs/user-manual')));
for (const extension of ['dmg', 'zip']) {
  const file = join(projectRoot, `dist/Familiar-Agent-Bridge-${pkg.version}-arm64.${extension}`);
  assert.ok((await stat(file)).size > 1000000);
}
console.log(`安装包静态审查通过：${files.length} 个应用文件；入口与相对依赖完整；无私有状态、密钥配置或开发规则；资源/手册与工作区一致。`);
