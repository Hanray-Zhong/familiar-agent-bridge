import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';

export async function findMarkdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findMarkdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files.sort();
}

export async function checkMarkdownLinks(files) {
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    assert.equal((text.match(/^```/gm) || []).length % 2, 0, `代码块未闭合：${file}`);
    for (const [, raw] of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = raw.replace(/^<|>$/g, '').split('#')[0];
      if (!target || /^https?:/.test(target)) continue;
      await access(resolve(dirname(file), target));
    }
  }
}
