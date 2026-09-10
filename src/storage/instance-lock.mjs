import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeAtomicJson } from './atomic-json.mjs';

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}

export async function acquireLock(file) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, host: hostname(), nonce: randomUUID(), startedAt: new Date().toISOString() };
  async function create() {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
    finally { await handle.close(); }
  }
  try { await create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // 串行化旧锁回收，不能让两个启动者同时删掉对方新建的锁。
    const reaper = `${file}.reaper`;
    let guard;
    try { guard = await open(reaper, 'wx', 0o600); }
    catch { throw new Error(`另一个进程正在处理实例锁：${file}`); }
    try {
      const previous = JSON.parse(await readFile(file, 'utf8'));
      if (!Number.isInteger(previous.pid) || previous.pid <= 0 || previous.host !== hostname() || alive(previous.pid)) {
        throw new Error(`Bridge 实例锁已占用或无法安全核验：${file}，PID=${previous.pid}`);
      }
      if (Number.isInteger(previous.runtimePid) && previous.runtimePid > 0 && alive(previous.runtimePid)) {
        throw new Error(`旧 Bridge 的 App Server 仍可能运行，拒绝并发接管；请核对 PID=${previous.runtimePid}`);
      }
      await unlink(file);
      await create();
    } finally { await guard.close(); await unlink(reaper); }
  }
  const release = async () => {
    const current = JSON.parse(await readFile(file, 'utf8'));
    if (current.nonce !== owner.nonce) throw new Error('实例锁所有权已改变，拒绝删除其他进程的锁');
    await unlink(file);
  };
  release.setRuntimePid = async runtimePid => {
    owner.runtimePid = runtimePid;
    await writeAtomicJson(file, owner);
  };
  return release;
}
