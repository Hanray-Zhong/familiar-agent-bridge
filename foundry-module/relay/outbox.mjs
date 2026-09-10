import { ROUTES } from '../shared/protocol.mjs';

const terminal = new Set(['processed', 'uncertain', 'cancelled']);
export const emptyOutbox = () => ({ version: 1, cursor: 0, pending: [], watching: [], recent: [], blocked: false, gapSince: null, gapVersion: 0 });

export class Outbox {
  constructor({ read, write, post, notify = () => {}, clock = Date.now, maxPending = 500 }) {
    Object.assign(this, { read, write, post, notify, clock, maxPending });
    this.tail = Promise.resolve();
    this.stopped = false;
    this.nextStatusAt = 0;
    this.statusOffset = 0;
  }

  async load() {
    this.state = structuredClone(await this.read() ?? emptyOutbox());
    if (this.state.version !== 1 || !Number.isFinite(this.state.cursor) || this.state.cursor < 0 ||
        !['pending', 'watching', 'recent'].every(key => Array.isArray(this.state[key]))) throw new Error('本客户端待发记录损坏，已停止推送');
  }

  mutate(fn) {
    const operation = this.tail.then(async () => {
      const next = structuredClone(this.state);
      const result = fn(next);
      await this.write(next);
      this.state = next;
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  async observe(event, timestamp) {
    const full = await this.mutate(state => {
      if (event && !state.pending.some(item => item.event.id === event.id) && !state.watching.includes(event.id) && !state.recent.includes(event.id)) {
        if (state.pending.length >= this.maxPending) {
          state.gapSince = Math.min(state.gapSince ?? timestamp, timestamp);
          state.gapVersion = (state.gapVersion ?? 0) + 1;
          return true;
        }
        state.pending.push({ event, attempts: 0, nextAt: 0 });
        state.pending.sort((a, b) => Date.parse(a.event.timestamp) - Date.parse(b.event.timestamp) || a.event.id.localeCompare(b.event.id));
      }
      state.cursor = Math.max(state.cursor, timestamp);
      return false;
    });
    if (full) throw Object.assign(new Error('本客户端待发队列已满；消息仍在 Foundry，将在有空位后补投'), { code: 'OUTBOX_FULL' });
  }

  clearGap(version) { return this.mutate(state => { if (state.gapVersion === version) state.gapSince = null; }); }

  async pump() {
    if (this.stopped || this.pumping) return;
    this.pumping = this.runPump();
    try { await this.pumping; } finally { this.pumping = null; }
  }

  async runPump() {
    await this.tail;
    const first = this.state.pending[0];
    if (first && !this.state.blocked && first.nextAt <= this.clock()) {
      try {
        const result = await this.post(ROUTES.events, { event: first.event });
        if (result.id !== first.event.id || !['queued', 'running', ...terminal].includes(result.status)) {
          throw Object.assign(new Error('Bridge 没有返回有效持久化回执'), { retryable: false });
        }
        await this.mutate(state => {
          state.pending = state.pending.filter(item => item.event.id !== first.event.id);
          if (terminal.has(result.status)) state.recent.push(result.id);
          else state.watching.push(result.id);
          state.recent = state.recent.slice(-500);
        });
        if (result.status === 'uncertain') this.notify('存在结果待核对的请求，不会自动重发');
      } catch (error) {
        await this.mutate(state => {
          const current = state.pending.find(item => item.event.id === first.event.id);
          if (!current) return;
          current.attempts++;
          current.nextAt = this.clock() + Math.min(60000, 1000 * 2 ** current.attempts);
          state.blocked = error.retryable === false || current.attempts >= 8;
        });
        if (this.state.blocked || first.attempts === 0) this.notify(error.message);
      }
    }
    if (!this.stopped && this.state.watching.length && this.clock() >= this.nextStatusAt) {
      this.nextStatusAt = this.clock() + 10000;
      try {
        const ids = this.state.watching.slice(this.statusOffset, this.statusOffset + 100);
        this.statusOffset = (this.statusOffset + 100) % this.state.watching.length;
        const result = await this.post(ROUTES.status, { ids });
        if (!Array.isArray(result.receipts)) throw new Error('状态回执无效');
        const finished = result.receipts.filter(receipt => terminal.has(receipt.status));
        await this.mutate(state => {
          for (const receipt of finished) { state.watching = state.watching.filter(id => id !== receipt.id); state.recent.push(receipt.id); }
          state.recent = state.recent.slice(-500);
        });
        if (finished.some(receipt => receipt.status === 'uncertain')) this.notify('有请求的执行结果不确定，请 GM 核对；不会自动重发');
        if (result.receipts.some(receipt => receipt.status === 'unknown')) this.notify('Bridge 缺少已接收请求的记录，请 GM 核对状态文件；不会自动重放');
      } catch { /* 只查询状态，不重新发送已经 ACK 的事件。 */ }
    }
  }

  retry() { return this.mutate(state => { state.blocked = false; for (const item of state.pending) { item.attempts = 0; item.nextAt = 0; } }); }
  async stop() { this.stopped = true; await this.pumping; await this.tail; }
}
