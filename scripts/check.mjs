import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectRoot } from '../src/runtime/config.mjs';
import { checkMarkdownLinks, findMarkdownFiles } from './lib/documentation.mjs';
import { configFields } from '../src/runtime/config-fields.mjs';
let count = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await check(file);
    else if (/\.(?:mjs|cjs|js|css|html)$/.test(entry.name)) {
      if (/\.(?:mjs|cjs|js)$/.test(entry.name)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit', timeout: 10000 });
      if (!directory.startsWith(join(projectRoot, 'test')) && (await readFile(file, 'utf8')).split('\n').length > 501) throw new Error(`源文件超过 500 行：${file}`);
      count++;
    }
  }
}
for (const directory of ['src', 'scripts', 'test', 'foundry-module', 'desktop']) await check(join(projectRoot, directory));
const manifest = JSON.parse(await readFile(join(projectRoot, 'foundry-module/module.json'), 'utf8'));
for (const file of [...manifest.esmodules, ...manifest.styles]) await readFile(join(projectRoot, 'foundry-module', file));
JSON.parse(await readFile(join(projectRoot, 'electron-builder.json'), 'utf8'));
const documents = ['README.md', 'AGENTS.md', 'agents/dm/AGENTS.md'].map(file => join(projectRoot, file));
documents.push(...await findMarkdownFiles(join(projectRoot, 'docs')));
await checkMarkdownLinks(documents);
const manual = await readFile(join(projectRoot, 'docs/user-manual/README.md'), 'utf8');
for (const { key } of configFields) if (!manual.includes('`' + key + '`')) throw new Error(`用户手册缺少配置项：${key}`);
console.log(`检查通过：${count} 个源码/界面文件；语法、行数、${documents.length} 份文档链接及 ${configFields.length} 项配置说明有效。`);
