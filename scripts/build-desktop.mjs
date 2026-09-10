import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ProcessTree } from '../src/codex/process-tree.mjs';
import { projectRoot } from '../src/runtime/config.mjs';

if (process.platform !== 'darwin') throw new Error('当前发行脚本用于 macOS，请在 Mac 上构建');
const child = spawn(process.execPath, [join(projectRoot, 'node_modules/electron-builder/cli.js'), '--config', 'electron-builder.json',
  '--mac', 'dmg', 'zip', '--arm64', '--publish', 'never'], { cwd: projectRoot, detached: true, stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.on('error', () => {});
const tree = new ProcessTree(child.pid);
const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
exited.catch(() => {});
let timer;
const cancel = () => { void tree.signal('SIGTERM').catch(error => console.error(error.message)); };
process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
try {
  await tree.start();
  console.log(`安装包构建 PID=${child.pid}，最多等待 5 分钟。`);
  const result = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('安装包构建超时')), 300000); })]);
  if (result.code !== 0) throw new Error(`安装包构建失败：code=${result.code} signal=${result.signal}`);
} finally {
  clearTimeout(timer); await tree.stop(child);
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
}
