import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const execute = promisify(execFile);

async function processRows() {
  const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,comm='], { timeout: 3000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
    return match ? [{ pid: +match[1], ppid: +match[2], pgid: +match[3], identity: `${match[4]} ${match[5]}` }] : [];
  });
}

// Codex 的 MCP 子进程可能另建进程组，因此只 kill App Server 的组还不够。
export class ProcessTree {
  constructor(pid) {
    this.pid = pid;
    this.owned = new Map();
    this.tracking = true;
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const rows = await processRows();
      const selected = new Set(rows.filter(row =>
        this.owned.get(row.pid) === row.identity || row.pgid === this.pid).map(row => row.pid));
      let previous;
      do {
        previous = selected.size;
        for (const row of rows) if (selected.has(row.ppid)) selected.add(row.pid);
      } while (selected.size !== previous);
      const live = rows.filter(row => selected.has(row.pid));
      for (const row of live) this.owned.set(row.pid, row.identity);
      return live;
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }

  async start() {
    await this.refresh();
    const tick = async () => {
      try { await this.refresh(); }
      catch (error) { this.trackingError = error; }
      if (this.tracking) { this.timer = setTimeout(tick, 500); this.timer.unref(); }
    };
    this.timer = setTimeout(tick, 500);
    this.timer.unref();
  }

  async signal(signal) {
    for (const row of (await this.refresh()).reverse()) {
      try { process.kill(row.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw new Error(`无法清理本次子进程 PID=${row.pid}: ${error.code}`); }
    }
  }

  async waitEmpty(attempts) {
    for (let i = 0; i < attempts; i++) {
      if (!(await this.refresh()).length) return true;
      await delay(100);
    }
    return !(await this.refresh()).length;
  }

  async stop(child) {
    this.tracking = false;
    clearTimeout(this.timer);
    await this.refresh();
    child.stdin.end();
    if (await this.waitEmpty(10)) return;
    await this.signal('SIGTERM');
    if (await this.waitEmpty(30)) return;
    await this.signal('SIGKILL');
    if (!await this.waitEmpty(20)) throw new Error(`子进程未退出：${(await this.refresh()).map(row => row.pid).join(', ')}`);
  }
}
