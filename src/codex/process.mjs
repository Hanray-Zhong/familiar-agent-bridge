import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ProcessTree } from './process-tree.mjs';
const execute = promisify(execFile);

export async function inspectCodex(command, cwd) {
  const options = { cwd, timeout: 15000, maxBuffer: 4 * 1024 * 1024 };
  const { stdout: version } = await execute(command, ['--version'], options);
  const { stdout } = await execute(command, ['mcp', 'list', '--json', '-c', 'features.plugins=false', '-c', 'features.apps=false'], options);
  // 配置内容仅由 CLI 解析；不保留、不打印地址、启动参数、认证信息。
  return { version: version.trim(), servers: JSON.parse(stdout).map(({ name, enabled }) => ({ name, enabled })) };
}

export function spawnServer(command, args, cwd) {
  const child = spawn(command, args, { cwd, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  if (child.pid) child.processTree = new ProcessTree(child.pid);
  return child;
}

export async function stopServer(child) {
  if (!child?.pid) return;
  await child.processTree.stop(child);
}
