import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { ProcessTree } from '../src/codex/process-tree.mjs';

test('关闭清理独立进程组的 MCP 模拟子进程，而不只清理父进程', { timeout: 15000 }, async t => {
  // 权限不足时在启动 fixture 前失败，避免清理工具不可用却已创建后台进程。
  await promisify(execFile)('ps', ['-p', String(process.pid), '-o', 'pid='], { timeout: 3000 });
  const fixture = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(1), 12000)'], { detached: true, stdio: 'ignore' });
    setTimeout(() => process.exit(1), 12000).unref();
    process.stdout.write(String(child.pid) + '\\n');
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
  `;
  const child = spawn(process.execPath, ['-e', fixture], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const tree = new ProcessTree(child.pid);
  t.after(() => tree.stop(child));
  const [data] = await once(child.stdout, 'data');
  const descendant = Number(String(data).trim());
  await tree.start();
  assert.ok(tree.owned.has(descendant));
  await tree.stop(child);
  assert.equal((await tree.refresh()).length, 0);
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
});
